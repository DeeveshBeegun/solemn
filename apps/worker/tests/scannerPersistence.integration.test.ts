import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createScannerRepository,
  marketEvents,
  migrateDatabase,
  scannerGaps,
  tokens,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import type { ScannerEvent } from '@solemn/shared';
import { normalizeMessage } from '../src/scanner/eventNormalizer.js';
import {
  launch,
  launchRaw,
  LATER,
  migrationRaw,
  MINT,
  NOW,
  OTHER_MINT,
} from './scannerFixtures.js';

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
beforeAll(async () => {
  await migrateDatabase(database.db);
});
afterAll(async () => {
  await database.close();
});

export function normalized(raw: string, received = NOW): ScannerEvent {
  const parsed = normalizeMessage(raw, received);
  if (parsed.kind !== 'event') throw new Error('Invalid scanner fixture');
  return parsed.value;
}
async function rolledBack(
  test: (tx: Database) => Promise<void>,
): Promise<void> {
  const rollback = new Error('ROLLBACK_TEST_FIXTURES');
  try {
    await database.db.transaction(async (tx) => {
      await test(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe('scanner transactional persistence', () => {
  it('inserts a token and exact raw provider event atomically', async () =>
    rolledBack(async (tx) => {
      const repository = createScannerRepository(tx);
      const raw = launchRaw.replace(
        /}$/,
        ',"slot":9007199254740993,"exactNumber":0.123456789012345678901}',
      );
      expect(await repository.persistEvent(normalized(raw))).toBe('INSERTED');
      const row = (
        await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT))
      )[0];
      expect(row?.name).toBe(launch.name);
      expect(row?.decimals).toBeNull();
      expect(row?.createdAt).toBeNull();
      const stored = (
        await tx
          .select()
          .from(marketEvents)
          .where(eq(marketEvents.tokenMint, MINT))
      )[0];
      expect(stored?.rawMessage).toBe(raw);
      expect(stored?.slot).toBe(9007199254740993n);
      const exact = await tx.execute(
        sql`SELECT raw_payload->>'exactNumber' AS exact FROM market_events WHERE id = ${stored?.id}`,
      );
      expect(exact.rows[0]?.exact).toBe('0.123456789012345678901');
    }));
  it('deduplicates tokens and events while retaining original receipt and payload', async () =>
    rolledBack(async (tx) => {
      const repository = createScannerRepository(tx);
      const first = normalized(launchRaw);
      await repository.persistEvent(first);
      expect(await repository.persistEvent(normalized(launchRaw, LATER))).toBe(
        'DUPLICATE',
      );
      expect(
        await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT)),
      ).toHaveLength(1);
      const rows = await tx
        .select()
        .from(marketEvents)
        .where(eq(marketEvents.tokenMint, MINT));
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0]?.ingestedAt ?? '').toISOString()).toBe(NOW);
    }));
  it('stores migration before creation with nullable placeholder metadata', async () =>
    rolledBack(async (tx) => {
      const repository = createScannerRepository(tx);
      await repository.persistEvent(normalized(migrationRaw));
      let row = (
        await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT))
      )[0];
      expect(row?.name).toBeNull();
      expect(row?.migrationStatus).toBe('MIGRATED');
      expect(row?.poolAddress).toBe(OTHER_MINT);
      await tx
        .update(tokens)
        .set({ riskStatus: 'ELIGIBLE' })
        .where(eq(tokens.mintAddress, MINT));
      await repository.persistEvent(normalized(launchRaw, LATER));
      row = (
        await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT))
      )[0];
      expect(row?.name).toBe(launch.name);
      expect(row?.migrationStatus).toBe('MIGRATED');
      expect(row?.riskStatus).toBe('ELIGIBLE');
      expect(row?.poolAddress).toBe(OTHER_MINT);
      expect(row?.createdAt).toBeNull();
    }));
  it('updates a launch pool with a reliable migration destination and preserves source chronology', async () =>
    rolledBack(async (tx) => {
      const repository = createScannerRepository(tx);
      const launchWithTime = normalized(
        JSON.stringify({ ...launch, timestamp: NOW, poolAddress: MINT }),
        LATER,
      );
      await repository.persistEvent(launchWithTime);
      await repository.persistEvent(normalized(migrationRaw, LATER));
      const row = (
        await tx.select().from(tokens).where(eq(tokens.mintAddress, MINT))
      )[0];
      expect(row?.poolAddress).toBe(OTHER_MINT);
      expect(new Date(row?.createdAt ?? '').toISOString()).toBe(NOW);
      const events = await tx
        .select()
        .from(marketEvents)
        .where(eq(marketEvents.tokenMint, MINT));
      expect(events).toHaveLength(2);
      expect(
        events.find((event) => event.eventType === 'TOKEN_MIGRATED')?.eventAt,
      ).toBeNull();
    }));
  it('rolls back a placeholder insert if the event insert fails', async () =>
    rolledBack(async (tx) => {
      const repository = createScannerRepository(tx);
      const first = normalized(launchRaw);
      await repository.persistEvent(first);
      const conflicting = normalized(
        JSON.stringify({ ...launch, mint: OTHER_MINT }),
      );
      conflicting.event.id = first.event.id;
      await expect(repository.persistEvent(conflicting)).rejects.toMatchObject({
        cause: { code: '23505' },
      });
      expect(
        await tx
          .select()
          .from(tokens)
          .where(eq(tokens.mintAddress, OTHER_MINT)),
      ).toHaveLength(0);
    }));
  it('records gap intervals and closes older open downtime on restoration', async () =>
    rolledBack(async (tx) => {
      const repository = createScannerRepository(tx);
      const gap = {
        id: '00000000-0000-4000-8000-000000000060',
        source: 'PUMPPORTAL' as const,
        startedAt: NOW,
        endedAt: null,
        reason: 'DISCONNECTED' as const,
      };
      await repository.recordGap(gap);
      await repository.recordGap({
        ...gap,
        id: '00000000-0000-4000-8000-000000000061',
        reason: 'STARTUP',
        startedAt: LATER,
        endedAt: LATER,
      });
      const row = (
        await tx
          .select()
          .from(scannerGaps)
          .where(
            and(
              eq(scannerGaps.id, gap.id),
              eq(scannerGaps.source, 'PUMPPORTAL'),
            ),
          )
      )[0];
      expect(new Date(row?.endedAt ?? '').toISOString()).toBe(LATER);
    }));
  it('backdates restart uncertainty to the last durable event receipt after a crash', async () =>
    rolledBack(async (tx) => {
      const repository = createScannerRepository(tx);
      await repository.persistEvent(normalized(launchRaw, NOW));
      const gap = {
        id: '00000000-0000-4000-8000-000000000062',
        source: 'PUMPPORTAL' as const,
        startedAt: LATER,
        endedAt: null,
        reason: 'STARTUP' as const,
      };
      await repository.recordGap(gap);
      const row = (
        await tx.select().from(scannerGaps).where(eq(scannerGaps.id, gap.id))
      )[0];
      expect(new Date(row?.startedAt ?? '').toISOString()).toBe(NOW);
    }));
  it('surfaces unavailable database connections without falling back to another database', async () => {
    const unavailable = createDatabase(
      'postgresql://solemn_test:unused@127.0.0.1:1/solemn_test',
    );
    try {
      await expect(unavailable.verify()).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
    } finally {
      await unavailable.close();
    }
  });
});
