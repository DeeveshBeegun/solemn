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
