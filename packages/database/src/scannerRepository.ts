import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { scannerEventSchema, scannerGapSchema } from '@solemn/shared';
import type { ScannerEvent, ScannerGap } from '@solemn/shared';
import type { Database } from './client.js';
import { marketEvents, scannerGaps, tokens } from './schema.js';

export interface ScannerRepository {
  persistEvent(input: ScannerEvent): Promise<'INSERTED' | 'DUPLICATE'>;
  recordGap(input: ScannerGap): Promise<void>;
}

export function createScannerRepository(
  db: Database,
  options: { requestRiskAnalysis?: boolean } = {},
): ScannerRepository {
  return {
    async persistEvent(input) {
      const { event, token } = scannerEventSchema.parse(input);
      return db.transaction(async (tx) => {
        // Serialize updates for this mint, including concurrent migration-before-create arrivals.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${token.mintAddress}, 0))`,
        );
        await tx.insert(tokens).values(token).onConflictDoNothing();
        const inserted = await tx
          .insert(marketEvents)
          .values({
            ...event,
            slot: event.slot === null ? null : BigInt(event.slot),
            // PostgreSQL parses the original text, preserving exact provider JSON numbers.
            rawPayload: sql`${event.rawMessage}::jsonb`,
          })
          .onConflictDoNothing({
            target: [marketEvents.source, marketEvents.sourceEventId],
          })
          .returning({ id: marketEvents.id });
        if (inserted.length === 0) return 'DUPLICATE';
        const migrated = event.eventType === 'TOKEN_MIGRATED';
        const requestRisk = sql`(${options.requestRiskAnalysis ?? false} OR ${tokens.riskRequestId} IS NOT NULL)`;
        await tx
          .update(tokens)
          .set({
            riskStatus: sql`CASE WHEN ${requestRisk} THEN 'UNKNOWN'::risk_status ELSE ${tokens.riskStatus} END`,
            riskRequestId: sql`CASE WHEN ${requestRisk} THEN ${event.id}::uuid ELSE ${tokens.riskRequestId} END`,
            riskRequestedAt: sql`CASE WHEN ${requestRisk} THEN clock_timestamp() ELSE ${tokens.riskRequestedAt} END`,
            riskTrigger: sql`CASE WHEN ${requestRisk} THEN ${event.eventType} ELSE ${tokens.riskTrigger} END`,
            riskNextAssessmentAt: sql`CASE WHEN ${requestRisk} THEN clock_timestamp() ELSE ${tokens.riskNextAssessmentAt} END`,
            riskLeaseUntil: sql`CASE WHEN ${requestRisk} THEN NULL ELSE ${tokens.riskLeaseUntil} END`,
            riskAttemptCount: sql`CASE WHEN ${requestRisk} THEN 0 ELSE ${tokens.riskAttemptCount} END`,
            riskValidUntil: sql`CASE WHEN ${requestRisk} THEN NULL ELSE ${tokens.riskValidUntil} END`,
            name: sql`coalesce(${tokens.name}, ${token.name})`,
            symbol: sql`coalesce(${tokens.symbol}, ${token.symbol})`,
            decimals: sql`coalesce(${tokens.decimals}, ${token.decimals})`,
            createdAt: sql`coalesce(${tokens.createdAt}, ${token.createdAt}::timestamptz)`,
            discoveredAt: sql`least(${tokens.discoveredAt}, ${token.discoveredAt}::timestamptz)`,
            creatorAddress: sql`coalesce(${tokens.creatorAddress}, ${token.creatorAddress})`,
            bondingCurveAddress: sql`coalesce(${tokens.bondingCurveAddress}, ${token.bondingCurveAddress})`,
            // A late create must never regress a known migration or its destination.
            ...(migrated
              ? {
                  migrationStatus: 'MIGRATED' as const,
                  migrationObservedAt: sql`least(${tokens.migrationObservedAt}, ${token.discoveredAt}::timestamptz)`,
                  migratedAt: sql`coalesce(${tokens.migratedAt}, ${event.eventAt}::timestamptz)`,
                  migrationVenue: sql`coalesce(${tokens.migrationVenue}, ${token.migrationVenue})`,
                  poolAddress: sql`CASE WHEN ${tokens.migrationStatus} = 'UNKNOWN' THEN coalesce(${token.poolAddress}, ${tokens.poolAddress}) ELSE coalesce(${tokens.poolAddress}, ${token.poolAddress}) END`,
                }
              : {}),
          })
          .where(eq(tokens.mintAddress, token.mintAddress));
        return 'INSERTED';
      });
    },
    async recordGap(input) {
      const gap = scannerGapSchema.parse(input);
      await db.transaction(async (tx) => {
        // On restart, conservatively include downtime since the last durable local
        // observation. This also covers a crash that could not write a shutdown marker.
        const startedAt =
          gap.reason === 'STARTUP'
            ? sql`least(${gap.startedAt}::timestamptz, coalesce(greatest(
          (SELECT max(ingested_at) FROM market_events WHERE source = 'PUMPPORTAL'),
          (SELECT max(coalesce(ended_at, started_at)) FROM scanner_gaps WHERE source = 'PUMPPORTAL')
        ), ${gap.startedAt}::timestamptz))`
            : gap.startedAt;
        await tx
          .insert(scannerGaps)
          .values({ ...gap, startedAt })
          .onConflictDoUpdate({
            target: scannerGaps.id,
            set: {
              endedAt: gap.endedAt,
              startedAt: sql`least(${scannerGaps.startedAt}, ${gap.startedAt}::timestamptz)`,
            },
          });
        if (gap.endedAt !== null) {
          // One scanner process per database. A restored subscription also ends older
          // open intervals left by shutdown/crash, conservatively including downtime.
          await tx
            .update(scannerGaps)
            .set({ endedAt: gap.endedAt })
            .where(
              and(
                eq(scannerGaps.source, gap.source),
                isNull(scannerGaps.endedAt),
                lte(scannerGaps.startedAt, gap.endedAt),
              ),
            );
        }
      });
    },
  };
}
