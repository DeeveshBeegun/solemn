import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  idSchema,
  mintAddressSchema,
  timestampSchema,
  tokenRiskAssessmentSchema,
} from '@solemn/shared';
import type { RiskJob, TokenRiskAssessment } from '@solemn/shared';
import type { Database } from './client.js';
import { tokenRiskAssessments, tokens } from './schema.js';

export interface RiskRepository {
  request(mint: string, requestId: string, now: string): Promise<boolean>;
  claim(
    limit: number,
    now: string,
    leaseMs: number,
    maxAttempts: number,
    mint?: string,
  ): Promise<RiskJob[]>;
  persist(
    assessment: TokenRiskAssessment,
    nextAssessmentAt: string | null,
  ): Promise<'CURRENT' | 'HISTORICAL' | 'DUPLICATE'>;
  expire(now: string): Promise<void>;
}
function domainAssessment(
  row: typeof tokenRiskAssessments.$inferSelect,
): TokenRiskAssessment {
  return tokenRiskAssessmentSchema.parse({
    id: row.id,
    tokenMint: row.tokenMint,
    requestId: row.requestId,
    attempt: row.attempt,
    requestedAt: new Date(row.requestedAt).toISOString(),
    status: row.status,
    reasons: row.reasons,
    checks: row.checks,
    policy: row.policy,
    policyHash: row.policyHash,
    assessedAt: new Date(row.assessedAt).toISOString(),
    validUntil:
      row.validUntil === null ? null : new Date(row.validUntil).toISOString(),
    evidence: row.evidence,
  });
}

export function createRiskRepository(db: Database): RiskRepository {
  return {
    async request(inputMint, inputId, inputTime) {
      const mint = mintAddressSchema.parse(inputMint),
        requestId = idSchema.parse(inputId),
        now = timestampSchema.parse(inputTime);
      return db.transaction(async (tx) => {
        await tx
          .insert(tokens)
          .values({
            mintAddress: mint,
            name: null,
            symbol: null,
            decimals: null,
            createdAt: null,
            discoveredAt: now,
            sourcePlatform: 'MANUAL',
            poolAddress: null,
            riskStatus: 'UNKNOWN',
          })
          .onConflictDoNothing();
        const rows = await tx
          .update(tokens)
          .set({
            riskStatus: 'UNKNOWN',
            riskRequestId: requestId,
            riskRequestedAt: now,
            riskTrigger: 'MANUAL',
            riskNextAssessmentAt: now,
            riskLeaseUntil: null,
            riskAttemptCount: 0,
            riskValidUntil: null,
          })
          .where(
            and(
              eq(tokens.mintAddress, mint),
              or(
                isNull(tokens.riskRequestedAt),
                lte(tokens.riskRequestedAt, now),
              ),
              sql`${tokens.riskRequestId} IS DISTINCT FROM ${requestId}::uuid`,
            ),
          )
          .returning({ mint: tokens.mintAddress });
        return rows.length > 0;
      });
    },
    async expire(now) {
      await db
        .update(tokens)
        .set({ riskStatus: 'UNKNOWN' })
        .where(
          and(
            eq(tokens.riskStatus, 'ELIGIBLE'),
            or(isNull(tokens.riskValidUntil), lte(tokens.riskValidUntil, now)),
          ),
        );
    },
    async claim(limit, inputTime, leaseMs, maxAttempts, mint) {
      const now = timestampSchema.parse(inputTime);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20)
        throw new Error('Risk claim limit must be 1–20');
      if (mint !== undefined) mintAddressSchema.parse(mint);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(tokens)
          .where(
            and(
              isNotNull(tokens.riskRequestId),
              isNotNull(tokens.riskRequestedAt),
              sql`${tokens.riskAttemptCount} < ${maxAttempts}`,
              or(
                lte(tokens.riskNextAssessmentAt, now),
                and(
                  isNull(tokens.riskNextAssessmentAt),
                  isNotNull(tokens.riskLeaseUntil),
                  lte(tokens.riskLeaseUntil, now),
                ),
              ),
              or(
                isNull(tokens.riskLeaseUntil),
                lte(tokens.riskLeaseUntil, now),
              ),
              mint === undefined ? undefined : eq(tokens.mintAddress, mint),
            ),
          )
          .orderBy(asc(tokens.riskRequestedAt), asc(tokens.mintAddress))
          .limit(limit)
          .for('update', { skipLocked: true });
        const jobs: RiskJob[] = [];
        for (const row of rows) {
          await tx
            .update(tokens)
            .set({
              riskStatus: 'UNKNOWN',
              riskValidUntil: null,
              riskAttemptCount: row.riskAttemptCount + 1,
              riskNextAssessmentAt: null,
              riskLeaseUntil: new Date(Date.parse(now) + leaseMs).toISOString(),
            })
            .where(eq(tokens.mintAddress, row.mintAddress));
          const previous =
            row.latestRiskAssessmentId === null
              ? undefined
              : (
                  await tx
                    .select()
                    .from(tokenRiskAssessments)
                    .where(
                      eq(tokenRiskAssessments.id, row.latestRiskAssessmentId),
                    )
                )[0];
          jobs.push({
            tokenMint: row.mintAddress,
            requestId: row.riskRequestId as string,
            requestedAt: new Date(row.riskRequestedAt as string).toISOString(),
            attempt: row.riskAttemptCount + 1,
            trigger: row.riskTrigger ?? 'REASSESSMENT',
            previous: previous ? domainAssessment(previous) : null,
          });
        }
        return jobs;
      });
    },
    async persist(input, nextAt) {
      const assessment = tokenRiskAssessmentSchema.parse(input);
      if (nextAt !== null) timestampSchema.parse(nextAt);
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(tokenRiskAssessments)
          .values({ ...assessment, policyVersion: assessment.policy.version })
          .onConflictDoNothing()
          .returning({ id: tokenRiskAssessments.id });
        if (!inserted.length) return 'DUPLICATE';
        const metadata = assessment.evidence.jupiter;
        const updated = await tx
          .update(tokens)
          .set({
            riskStatus: assessment.status,
            riskAssessedAt: assessment.assessedAt,
            riskValidUntil: assessment.validUntil,
            latestRiskAssessmentId: assessment.id,
            riskLeaseUntil: null,
            riskNextAssessmentAt: nextAt,
            name: sql`coalesce(${tokens.name}, ${metadata.state === 'OK' ? metadata.name : null})`,
            symbol: sql`coalesce(${tokens.symbol}, ${metadata.state === 'OK' ? metadata.symbol : null})`,
            decimals: sql`coalesce(${tokens.decimals}, ${assessment.evidence.solana.validMint === true ? assessment.evidence.solana.decimals : null}::integer)`,
          })
          .where(
            and(
              eq(tokens.mintAddress, assessment.tokenMint),
              eq(tokens.riskRequestId, assessment.requestId),
              eq(tokens.riskAttemptCount, assessment.attempt),
              or(
                isNull(tokens.riskAssessedAt),
                lte(tokens.riskAssessedAt, assessment.assessedAt),
              ),
            ),
          )
          .returning({ mint: tokens.mintAddress });
        return updated.length ? 'CURRENT' : 'HISTORICAL';
      });
    },
  };
}

/** Mandatory Week 4 boundary: a stored ELIGIBLE flag alone is insufficient. */
export async function listEligibleRiskCandidates(
  db: Database,
  now: string,
  policyHash: string,
  limit = 100,
) {
  timestampSchema.parse(now);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Candidate limit must be 1–1000');
  return db
    .select({
      tokenMint: tokens.mintAddress,
      assessmentId: tokenRiskAssessments.id,
      assessedAt: tokenRiskAssessments.assessedAt,
      validUntil: tokenRiskAssessments.validUntil,
    })
    .from(tokens)
    .innerJoin(
      tokenRiskAssessments,
      eq(tokens.latestRiskAssessmentId, tokenRiskAssessments.id),
    )
    .where(
      and(
        eq(tokens.riskStatus, 'ELIGIBLE'),
        eq(tokenRiskAssessments.status, 'ELIGIBLE'),
        eq(tokenRiskAssessments.policyHash, policyHash),
        eq(tokenRiskAssessments.requestId, tokens.riskRequestId),
        eq(tokenRiskAssessments.tokenMint, tokens.mintAddress),
        gt(tokens.riskValidUntil, now),
        gt(tokenRiskAssessments.validUntil, now),
        lte(tokenRiskAssessments.assessedAt, now),
        isNull(tokens.riskLeaseUntil),
      ),
    )
    .limit(limit);
}
