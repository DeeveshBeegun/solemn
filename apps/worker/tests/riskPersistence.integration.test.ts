import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createRiskRepository,
  createScannerRepository,
  listEligibleRiskCandidates,
  migrateDatabase,
  tokenRiskAssessments,
  tokens,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import { queryEligibleTokens } from '../src/ui/eligibleTokens.js';
import { loadConfig } from '../src/config/index.js';
import {
  evaluateTokenRisk,
  policyHash,
  riskPolicy,
} from '../src/risk/tokenRiskEngine.js';
import { normalizeMessage } from '../src/scanner/eventNormalizer.js';
import { emptyJupiter } from '../src/analysis/observations.js';
import { goodJupiter, goodSecurity, id, MINT, NOW } from './riskFixtures.js';
import { launchRaw, migrationRaw } from './scannerFixtures.js';

config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const database = createDatabase(
  assertSafeTestDatabase(
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
  ),
);
const policy = riskPolicy(
  loadConfig({ DATABASE_URL: 'postgresql://localhost/solemn' }),
);
const LATER = '2026-01-01T00:00:01.000Z';
beforeAll(async () => {
  await migrateDatabase(database.db);
});
afterAll(async () => {
  await database.close();
});
async function rolledBack(test: (tx: Database) => Promise<void>) {
  const rollback = new Error('ROLLBACK_RISK_FIXTURES');
  try {
    await database.db.transaction(async (tx) => {
      await test(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe('risk history and durable worklist', () => {
  it('stores evidence, current status, expiry and a policy-scoped candidate atomically', async () =>
    rolledBack(async (tx) => {
      const repository = createRiskRepository(tx);
      await repository.request(MINT, id(200), NOW);
      const job = (await repository.claim(1, NOW, 1000, 3))[0];
      if (!job) throw new Error('Missing job');
      const assessment = evaluateTokenRisk(
        job,
        goodJupiter(),
        goodSecurity(),
        policy,
        NOW,
      );
      expect(await repository.persist(assessment, LATER)).toBe('CURRENT');
      const current = (
        await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT))
      )[0];
      expect(current?.riskStatus).toBe('ELIGIBLE');
      expect(current?.latestRiskAssessmentId).toBe(assessment.id);
      const history = (
        await tx
          .select()
          .from(tokenRiskAssessments)
          .where(eq(tokenRiskAssessments.tokenMint, MINT))
      )[0];
      expect(history?.evidence.jupiter.rawResponse).toBe('{"fixture":true}');
      expect(history?.checks.mintAuthorityDisabled).toBe(true);
      expect(
        await listEligibleRiskCandidates(tx, NOW, policyHash(policy)),
      ).toHaveLength(1);
      expect(
        await listEligibleRiskCandidates(tx, NOW, 'another-policy'),
      ).toHaveLength(0);
      expect(
        await listEligibleRiskCandidates(
          tx,
          '2026-01-01T00:01:01.000Z',
          policyHash(policy),
        ),
      ).toHaveLength(0);
      await repository.expire('2026-01-01T00:01:01.000Z');
      expect(
        (await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT)))[0]
          ?.riskStatus,
      ).toBe('UNKNOWN');
    }));
  it('deduplicates requests and assessments without resetting an active attempt', async () =>
    rolledBack(async (tx) => {
      const repository = createRiskRepository(tx);
      expect(await repository.request(MINT, id(201), NOW)).toBe(true);
      const job = (await repository.claim(1, NOW, 1000, 3))[0];
      if (!job) throw new Error('Missing job');
      expect(await repository.request(MINT, id(201), LATER)).toBe(false);
      expect(await repository.claim(1, NOW, 1000, 3)).toHaveLength(0);
      const assessment = evaluateTokenRisk(
        job,
        goodJupiter(),
        goodSecurity(),
        policy,
        NOW,
      );
      await repository.persist(assessment, null);
      expect(await repository.persist(assessment, null)).toBe('DUPLICATE');
      expect(await tx.select().from(tokenRiskAssessments)).toHaveLength(1);
    }));
  it('preserves old history while a failed reassessment invalidates current eligibility', async () =>
    rolledBack(async (tx) => {
      const repository = createRiskRepository(tx);
      await repository.request(MINT, id(202), NOW);
      const old = (await repository.claim(1, NOW, 1000, 3))[0];
      if (!old) throw new Error('Missing job');
      await repository.persist(
        evaluateTokenRisk(old, goodJupiter(), goodSecurity(), policy, NOW),
        null,
      );
      await repository.request(MINT, id(203), LATER);
      expect(
        await listEligibleRiskCandidates(tx, LATER, policyHash(policy)),
      ).toHaveLength(0);
      const next = (await repository.claim(1, LATER, 1000, 3))[0];
      if (!next) throw new Error('Missing job');
      await repository.persist(
        evaluateTokenRisk(
          next,
          emptyJupiter(MINT, LATER),
          goodSecurity(MINT, LATER),
          policy,
          LATER,
        ),
        null,
      );
      expect(
        (await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT)))[0]
          ?.riskStatus,
      ).toBe('UNKNOWN');
      expect(await tx.select().from(tokenRiskAssessments)).toHaveLength(2);
    }));
  it('keeps late asynchronous results historical instead of overwriting a newer request', async () =>
    rolledBack(async (tx) => {
      const repository = createRiskRepository(tx);
      await repository.request(MINT, id(204), NOW);
      const first = (await repository.claim(1, NOW, 1000, 3))[0];
      if (!first) throw new Error('Missing job');
      await repository.request(MINT, id(205), LATER);
      const second = (await repository.claim(1, LATER, 1000, 3))[0];
      if (!second) throw new Error('Missing job');
      const newer = evaluateTokenRisk(
        second,
        goodJupiter(MINT, LATER),
        { ...goodSecurity(MINT, LATER), mintAuthorityDisabled: false },
        policy,
        LATER,
      );
      await repository.persist(newer, null);
      expect(
        await repository.persist(
          evaluateTokenRisk(first, goodJupiter(), goodSecurity(), policy, NOW),
          null,
        ),
      ).toBe('HISTORICAL');
      expect(
        (await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT)))[0]
          ?.latestRiskAssessmentId,
      ).toBe(newer.id);
      expect(await tx.select().from(tokenRiskAssessments)).toHaveLength(2);
    }));
  it('recovers expired leases within the attempt budget and rejects older attempts', async () =>
    rolledBack(async (tx) => {
      const repository = createRiskRepository(tx);
      await repository.request(MINT, id(206), NOW);
      const first = (await repository.claim(1, NOW, 1000, 2))[0];
      if (!first) throw new Error('Missing job');
      const second = (await repository.claim(1, LATER, 1000, 2))[0];
      if (!second) throw new Error('Missing reclaimed job');
      expect(second.attempt).toBe(2);
      expect(
        await repository.persist(
          evaluateTokenRisk(first, goodJupiter(), goodSecurity(), policy, NOW),
          null,
        ),
      ).toBe('HISTORICAL');
      await repository.persist(
        evaluateTokenRisk(
          second,
          goodJupiter(MINT, LATER),
          goodSecurity(MINT, LATER),
          policy,
          LATER,
        ),
        null,
      );
      expect(
        await repository.claim(1, '2026-01-01T00:02:00.000Z', 1000, 2),
      ).toHaveLength(0);
    }));
  it('marks launches and migrations pending transactionally, while duplicates do not reset jobs', async () =>
    rolledBack(async (tx) => {
      const scanner = createScannerRepository(tx, {
        requestRiskAnalysis: true,
      });
      const launch = normalizeMessage(launchRaw, NOW),
        migration = normalizeMessage(migrationRaw, NOW);
      if (launch.kind !== 'event' || migration.kind !== 'event')
        throw new Error('Invalid fixtures');
      await scanner.persistEvent(launch.value);
      const risk = createRiskRepository(tx);
      const now = new Date(Date.now() + 1000).toISOString();
      const job = (await risk.claim(1, now, 10000, 3))[0];
      expect(job?.requestId).toBe(launch.value.event.id);
      await scanner.persistEvent(launch.value);
      expect(
        (await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT)))[0]
          ?.riskAttemptCount,
      ).toBe(1);
      await scanner.persistEvent(migration.value);
      const current = (
        await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT))
      )[0];
      expect(current?.riskRequestId).toBe(migration.value.event.id);
      expect(current?.riskTrigger).toBe('TOKEN_MIGRATED');
      expect(current?.riskStatus).toBe('UNKNOWN');
      expect(current?.riskAttemptCount).toBe(0);
    }));
});

describe('dashboard eligibility alerts', () => {
  async function seed(tx: Database) {
    const repository = createRiskRepository(tx);
    await repository.request(MINT, id(9200), NOW);
    const claimed = (await repository.claim(1, NOW, 1000, 3))[0];
    if (!claimed) throw new Error('Missing alert assessment job');
    const assessment = evaluateTokenRisk(
      claimed,
      goodJupiter(),
      goodSecurity(),
      policy,
      NOW,
    );
    await repository.persist(assessment, null);
    return assessment;
  }
  it('returns current policy-scoped eligible tokens with safe metadata only', async () =>
    rolledBack(async (tx) => {
      const assessment = await seed(tx);
      const result = await queryEligibleTokens(tx, policyHash(policy), LATER);
      expect(result.total).toBe(1);
      expect(result.tokens[0]?.mint).toBe(MINT);
      expect(result.tokens[0]?.assessmentId).toBe(assessment.id);
      expect(result.tokens[0]?.liquidityUsd).toBe('50000');
      expect(result.tokens[0]?.validUntil).toBe(assessment.validUntil);
      expect(JSON.stringify(result)).not.toContain('rawResponse');
      expect(JSON.stringify(result)).not.toContain('evidence');
      expect(
        (await queryEligibleTokens(tx, 'other-policy', LATER)).tokens,
      ).toEqual([]);
      expect(
        (
          await queryEligibleTokens(
            tx,
            policyHash(policy),
            assessment.validUntil!,
          )
        ).tokens,
      ).toEqual([]);
      expect(
        (
          await queryEligibleTokens(
            tx,
            policyHash(policy),
            '2025-12-31T23:59:59.000Z',
          )
        ).tokens,
      ).toEqual([]);
    }));
  it('excludes fixture sources and synthetic triggers even when their risk is eligible', async () =>
    rolledBack(async (tx) => {
      await seed(tx);
      for (const sourcePlatform of [
        'fixture',
        'PAPER_FIXTURE',
        'SOLEMN_WEEK6_SYNTHETIC',
        'FORWARD_REPLAY',
      ]) {
        await tx
          .update(tokens)
          .set({ sourcePlatform })
          .where(eq(tokens.mintAddress, MINT));
        expect(
          (await queryEligibleTokens(tx, policyHash(policy), LATER)).tokens,
        ).toEqual([]);
      }
      await tx
        .update(tokens)
        .set({ sourcePlatform: 'MANUAL', riskTrigger: 'FIXTURE' })
        .where(eq(tokens.mintAddress, MINT));
      expect(
        (await queryEligibleTokens(tx, policyHash(policy), LATER)).tokens,
      ).toEqual([]);
    }));
  it('ignores stale flags, mismatched requests and in-flight risk work', async () =>
    rolledBack(async (tx) => {
      const assessment = await seed(tx);
      await tx
        .update(tokens)
        .set({ riskLeaseUntil: '2026-01-01T00:00:30.000Z' })
        .where(eq(tokens.mintAddress, MINT));
      expect(
        (await queryEligibleTokens(tx, policyHash(policy), LATER)).tokens,
      ).toEqual([]);
      await tx
        .update(tokens)
        .set({ riskLeaseUntil: null, riskRequestId: id(9201) })
        .where(eq(tokens.mintAddress, MINT));
      expect(
        (await queryEligibleTokens(tx, policyHash(policy), LATER)).tokens,
      ).toEqual([]);
      await tx
        .update(tokens)
        .set({ riskRequestId: assessment.requestId, riskStatus: 'REJECTED' })
        .where(eq(tokens.mintAddress, MINT));
      expect(
        (await queryEligibleTokens(tx, policyHash(policy), LATER)).tokens,
      ).toEqual([]);
      await tx
        .update(tokens)
        .set({ riskStatus: 'ELIGIBLE', riskValidUntil: NOW })
        .where(eq(tokens.mintAddress, MINT));
      expect(
        (await queryEligibleTokens(tx, policyHash(policy), LATER)).tokens,
      ).toEqual([]);
    }));
});
