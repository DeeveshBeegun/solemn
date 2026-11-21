import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import {
  assertSafeTestDatabase,
  createDatabase,
  migrateDatabase,
  createRiskRepository,
  createStrategyRepository,
  createPaperRepository,
  strategyDecisions,
  tokens,
  marketCandles,
  currentStrategyRisks,
} from '@solemn/database';
import { fromAtomic, stableId, toAtomic } from '@solemn/shared';
import { createFreePaperExecutor } from '../src/portfolio/freePaperExecutor.js';
import { signed } from '../src/portfolio/decimal.js';
import { applyPaperCommand } from '../src/portfolio/portfolioManager.js';
import { freeSpotObservation } from '../src/execution/freeSpotExecution.js';
import {
  createFreePaperDecisionService,
  evaluateFreePaperSnapshot,
  freePaperProfile,
} from '../src/portfolio/freePaperDecisions.js';
import {
  initialPortfolio,
  initialPosting,
} from '../src/portfolio/accountingService.js';
import { initialStrategyState } from '../src/strategy/signalEngine.js';
import {
  evaluateTokenRisk,
  policyHash,
  riskPolicy,
} from '../src/risk/tokenRiskEngine.js';
import { queryPaperEntryAlerts } from '../src/ui/paperEntryAlerts.js';
import { loadConfig } from '../src/config/index.js';
import {
  freeSnapshot,
  fixtureRisk,
  executionSnapshot,
} from './freeLiveFixtures.js';
import { goodJupiter, goodSecurity } from './riskFixtures.js';
dotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const safe = assertSafeTestDatabase(
  process.env.TEST_DATABASE_URL,
  process.env.DATABASE_URL,
);
const control = createDatabase(safe, undefined, { storageMaintenance: false });
const name = 'solemn_free_live_' + randomUUID().replaceAll('-', '');
let created = false;
let database: ReturnType<typeof createDatabase>;
let url: string;
const logger = pino({ level: 'silent' });
beforeAll(async () => {
  await control.pool.query('CREATE DATABASE "' + name + '"');
  created = true;
  const next = new URL(safe);
  next.pathname = '/' + name;
  url = next.href;
  database = createDatabase(url, undefined, { storageMaintenance: false });
  await migrateDatabase(database.db);
});
afterAll(async () => {
  await database?.close();
  if (created)
    await control.pool.query('DROP DATABASE "' + name + '" WITH (FORCE)');
  await control.close();
});

it('starts the live engine, records a genuine live-mode entry decision, and resumes the same account without fills or duplicates', async () => {
  const config = loadConfig({
    DATABASE_URL: url,
    STRATEGY_ENABLED: 'true',
    PAPER_TRADING_ENABLED: 'true',
    LIVE_PAPER_DECISIONS_ENABLED: 'true',
    FREE_PAPER_ACCOUNT_NAME: 'integration-live-account',
  });
  const input = freeSnapshot(config, 14);
  const now = () => Date.parse(input.receivedAt);
  const { run, definition } = freePaperProfile(
    config,
    '2026-01-01T00:00:00.000Z',
  );
  const repository = createStrategyRepository(database.db),
    paper = createPaperRepository(database.db);
  await repository.begin(run);
  await paper.initialize(
    definition,
    initialPortfolio(definition),
    initialPosting(definition),
  );
  const risk = createRiskRepository(database.db);
  await risk.request(input.mint, randomUUID(), input.receivedAt);
  const claimed = (
    await risk.claim(1, input.receivedAt, 1000, 3, input.mint)
  )[0]!;
  await risk.persist(
    evaluateTokenRisk(
      claimed,
      goodJupiter(input.mint, input.receivedAt),
      goodSecurity(input.mint, input.receivedAt),
      riskPolicy(config),
      input.receivedAt,
    ),
    null,
  );
  let state = initialStrategyState();
  for (const end of [12, 13]) {
    const snapshot = freeSnapshot(config, end);
    const decision = evaluateFreePaperSnapshot(
      config,
      run.id,
      snapshot,
      fixtureRisk(config, snapshot.receivedAt),
      state,
      snapshot.receivedAt,
    );
    await repository.save(run, decision, snapshot.candles, []);
    state = decision.stateAfter;
  }
  const read = vi.fn().mockResolvedValue(input);
  const service = createFreePaperDecisionService(config, database, logger, {
    client: { read },
    now,
  });
  const competing = createFreePaperDecisionService(config, database, logger, {
    client: { read },
    now,
  });
  try {
    await service.start();
    await expect(competing.start()).rejects.toThrow('Another forward worker');
    await vi.waitFor(
      async () => {
        const decisions = await database.db
          .select()
          .from(strategyDecisions)
          .where(
            and(
              eq(strategyDecisions.runId, run.id),
              eq(strategyDecisions.outcome, 'BUY_CANDIDATE'),
            ),
          );
        expect(decisions).toHaveLength(1);
      },
      { timeout: 10000 },
    );
    expect(service.status).toBe('LIVE_DECISION_RECORDED');
    const data = await queryPaperEntryAlerts(
      database.db,
      new Date().toISOString(),
    );
    const entry = data.entries.find((e) => e.portfolioId === definition.id);
    expect(entry).toMatchObject({
      sourceKind: 'LIVE_PAPER',
      dataMode: 'FORWARD_LIVE',
      status: 'CANDIDATE_ONLY',
      fillPriceUsd: null,
    });
    expect(read).toHaveBeenCalledTimes(1);
    const decision = (
      await database.db
        .select()
        .from(strategyDecisions)
        .where(eq(strategyDecisions.signalId, entry!.signalId))
    )[0]!;
    expect(decision.payload.candidate?.dataMode).toBe('LIVE_PAPER');
    await expect(
      paper.transact(
        definition.id,
        {
          type: 'ENTRY',
          id: stableId(['paper-entry-v1', definition.id, entry!.signalId]),
          at: input.receivedAt,
          candidate: decision.payload.candidate!,
          risk: decision.payload.risk,
          observation: null,
        },
        () => {
          throw new Error('Live execution must not reach a reducer');
        },
      ),
    ).rejects.toThrow('Forward mutation requires an initialized owner');
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int AS n FROM trades WHERE portfolio_id=$1',
          [definition.id],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await service.stop();
    await competing.stop();
  }
  const restarted = createFreePaperDecisionService(config, database, logger, {
    client: { read },
    now,
  });
  try {
    await restarted.start();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await restarted.stop();
    const entries = await database.db
      .select()
      .from(strategyDecisions)
      .where(
        and(
          eq(strategyDecisions.runId, run.id),
          eq(strategyDecisions.outcome, 'BUY_CANDIDATE'),
        ),
      );
    expect(entries).toHaveLength(1);
    expect((await paper.snapshot(definition.id)).state.availableCashUsd).toBe(
      config.INITIAL_PAPER_BALANCE_USD,
    );
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int AS n FROM portfolio_balance_events WHERE portfolio_id=$1',
          [definition.id],
        )
      ).rows[0].n,
    ).toBe(1);
  } finally {
    await restarted.stop();
  }
});

it('keeps live candidates out of fixture runs and preserves the NOT_READY database gate', async () => {
  const live = (
    await database.db
      .select()
      .from(strategyDecisions)
      .where(eq(strategyDecisions.outcome, 'BUY_CANDIDATE'))
  )[0]!;
  await expect(
    database.pool.query(
      `UPDATE strategy_decisions SET payload=jsonb_set(payload,'{candidate,dataMode}','"FIXTURE"'::jsonb) WHERE id=$1`,
      [live.id],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  const stored = (
    await database.db
      .select()
      .from(strategyDecisions)
      .where(eq(strategyDecisions.id, live.id))
  )[0]!;
  expect(stored.payload.candidate?.dataMode).toBe('LIVE_PAPER');
});

it('leaves market gaps visible and never changes saved financial balances on failed input', async () => {
  const config = loadConfig({
    DATABASE_URL: url,
    STRATEGY_ENABLED: 'true',
    PAPER_TRADING_ENABLED: 'true',
    LIVE_PAPER_DECISIONS_ENABLED: 'true',
    FREE_PAPER_ACCOUNT_NAME: 'integration-unavailable',
  });
  const input = freeSnapshot(config, 14);
  // The same current live token can be evaluated by a different isolated account profile.
  const service = createFreePaperDecisionService(config, database, logger, {
    now: () => Date.parse(input.receivedAt),
    client: {
      read: async () => {
        throw new Error('Untrusted provider error body');
      },
    },
  });
  try {
    await service.start();
    await vi.waitFor(() =>
      expect(service.status).toBe('WAITING_FOR_MARKET_DATA'),
    );
    await vi.waitFor(async () =>
      expect(
        (
          await database.db
            .select()
            .from(strategyDecisions)
            .where(
              eq(
                strategyDecisions.runId,
                freePaperProfile(config, input.receivedAt).run.id,
              ),
            )
        ).length,
      ).toBeGreaterThan(0),
    );
    const rows = await database.db
      .select()
      .from(strategyDecisions)
      .where(
        eq(
          strategyDecisions.runId,
          freePaperProfile(config, input.receivedAt).run.id,
        ),
      );
    expect(
      rows.every(
        (r) => r.outcome === 'INSUFFICIENT_DATA' && r.signalId === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('Untrusted provider error body');
    expect(
      await database.db
        .select()
        .from(marketCandles)
        .where(
          eq(
            marketCandles.runId,
            freePaperProfile(config, input.receivedAt).run.id,
          ),
        ),
    ).toEqual([]);
    expect(
      (await createPaperRepository(database.db).load(service.portfolioId)).state
        .positions,
    ).toEqual([]);
    expect(
      (
        await database.db
          .select()
          .from(tokens)
          .where(eq(tokens.mintAddress, input.mint))
      )[0]?.riskStatus,
    ).toBe('ELIGIBLE');
  } finally {
    await service.stop();
  }
});

it('executes live paper buys and delayed stop exits, reconciles costs, and recovers without duplicate fills', async () => {
  const config = loadConfig({
    DATABASE_URL: url,
    STRATEGY_ENABLED: 'true',
    PAPER_TRADING_ENABLED: 'true',
    LIVE_PAPER_DECISIONS_ENABLED: 'true',
    LIVE_PAPER_EXECUTION_ENABLED: 'true',
    FREE_PAPER_ACCOUNT_NAME: 'integration-execution',
  });
  const input = freeSnapshot(config, 14);
  let at = input.receivedAt;
  const profile = freePaperProfile(config, at);
  const strategy = createStrategyRepository(database.db),
    paper = createPaperRepository(database.db);
  await strategy.begin(profile.run);
  await paper.initialize(
    profile.definition,
    initialPortfolio(profile.definition),
    initialPosting(profile.definition),
  );
  const assessment = (
    await currentStrategyRisks(
      database.db,
      at,
      policyHash(riskPolicy(config)),
      100,
    )
  )[0]!;
  const context = {
    currentStatus: 'ELIGIBLE' as const,
    currentRequestId: assessment.requestId,
    assessment,
    availableAt: at,
  };
  let state = initialStrategyState();
  for (const end of [12, 13, 14]) {
    const snapshot = freeSnapshot(config, end);
    const decision = evaluateFreePaperSnapshot(
      config,
      profile.run.id,
      snapshot,
      end === 14 ? context : fixtureRisk(config, snapshot.receivedAt),
      state,
      snapshot.receivedAt,
    );
    await strategy.save(profile.run, decision, snapshot.candles, []);
    state = decision.stateAfter;
  }
  const candidate = (
    await database.db
      .select()
      .from(strategyDecisions)
      .where(
        and(
          eq(strategyDecisions.runId, profile.run.id),
          eq(strategyDecisions.outcome, 'BUY_CANDIDATE'),
        ),
      )
  )[0]!.payload.candidate!;
  let lease = await database.acquireForwardOwnership(profile.definition.id);
  let released = false;
  let executor = createFreePaperExecutor(profile.definition, logger, () => at);
  try {
    // The trigger's own observation cannot fill the entry.
    await executor.process(lease.db, executionSnapshot(config, at));
    expect(
      (await paper.load(profile.definition.id)).state.positions,
    ).toHaveLength(0);
    at = new Date(Date.parse(at) + 10000).toISOString();
    const snapshot = executionSnapshot(config, at);
    await expect(
      paper.transact(
        profile.definition.id,
        {
          type: 'ENTRY',
          id: stableId(['paper-entry-v1', profile.definition.id, candidate.id]),
          at,
          candidate,
          risk: context,
          observation: freeSpotObservation(
            snapshot,
            'BUY',
            at,
            profile.definition.policy,
          ),
        },
        (s, d) =>
          applyPaperCommand(s, { type: 'TICK', id: stableId(['bad']), at }, d),
      ),
    ).rejects.toThrow('ownership session');
    await executor.process(lease.db, snapshot);
    const bought = (
      await paper.snapshot(profile.definition.id, { readOnly: true })
    ).state;
    expect(bought.positions).toHaveLength(1);
    expect(toAtomic(bought.buyFeesUsd)).toBeGreaterThan(0n);
    expect(
      toAtomic(bought.availableCashUsd) +
        toAtomic(bought.positions[0]!.costBasisUsd),
    ).toBe(toAtomic(config.INITIAL_PAPER_BALANCE_USD));
    const alert = (
      await queryPaperEntryAlerts(database.db, new Date().toISOString())
    ).entries.find((e) => e.portfolioId === profile.definition.id)!;
    expect(alert).toMatchObject({
      status: 'FILLED',
      sourceKind: 'LIVE_PAPER_SPOT',
    });
    expect(alert.quantity).not.toBeNull();
    const genuine = freeSpotObservation(
      snapshot,
      'BUY',
      at,
      profile.definition.policy,
    )!;
    for (const observation of [
      { ...genuine, priceUsd: '999' },
      { ...genuine, dataMode: 'FIXTURE' as const },
    ]) {
      const command = {
        type: 'ENTRY' as const,
        id: stableId(['paper-entry-v1', profile.definition.id, candidate.id]),
        at,
        candidate,
        risk: context,
        observation,
      };
      await expect(
        createPaperRepository(lease.db).transact(
          profile.definition.id,
          command,
          (s, d) => applyPaperCommand(s, command, d),
        ),
      ).rejects.toThrow('authentic persisted public trade evidence');
    }
    await executor.process(lease.db, snapshot);
    expect(
      (await paper.snapshot(profile.definition.id, { readOnly: true })).state
        .buyFeesUsd,
    ).toBe(bought.buyFeesUsd);
    at = new Date(Date.parse(at) + 10000).toISOString();
    await executor.process(lease.db, executionSnapshot(config, at, '0.5'));
    const triggered = (await paper.load(profile.definition.id)).state
      .positions[0]!;
    expect(triggered.pendingExitReason).toBe('STOP_LOSS');
    expect(triggered.quantity).toBe(bought.positions[0]!.quantity);
    await executor.unavailable(lease.db, input.mint, 'OFFLINE_GAP');
    const blocked = (await paper.load(profile.definition.id)).state;
    expect(blocked.positions[0]!.status).toBe('EXIT_BLOCKED');
    expect(blocked.positions[0]!.quantity).toBe(triggered.quantity);
    // Recovery uses the same persisted intent and balances on a new ownership session.
    lease.release();
    released = true;
    await vi.waitFor(async () => {
      lease = await database.acquireForwardOwnership(profile.definition.id);
      released = false;
    });
    executor = createFreePaperExecutor(profile.definition, logger, () => at);
    at = new Date(Date.parse(at) + 10000).toISOString();
    const landing = executionSnapshot(config, at, '0.49');
    await executor.process(lease.db, landing);
    await executor.process(lease.db, landing);
    const closed = (
      await paper.snapshot(profile.definition.id, { readOnly: true })
    ).state;
    expect(closed.positions[0]!.status).toBe('CLOSED');
    expect(closed.positions[0]!.quantity).toBe('0');
    expect(closed.investedCostBasisUsd).toBe('0');
    expect(closed.reservedCashUsd).toBe('0');
    expect(closed.availableCashUsd).toBe(
      fromAtomic(
        toAtomic(config.INITIAL_PAPER_BALANCE_USD) +
          signed(closed.realizedPnlUsd),
      ),
    );
    const fills = await database.pool.query(
      'SELECT side,count(*)::int AS n FROM trades WHERE portfolio_id=$1 GROUP BY side',
      [profile.definition.id],
    );
    expect(fills.rows.sort((a, b) => a.side.localeCompare(b.side))).toEqual([
      { side: 'BUY', n: 1 },
      { side: 'SELL', n: 1 },
    ]);
  } finally {
    if (!released) lease.release();
  }
});

async function seedExecutableProfile(name: string) {
  const config = loadConfig({
    DATABASE_URL: url,
    STRATEGY_ENABLED: 'true',
    PAPER_TRADING_ENABLED: 'true',
    LIVE_PAPER_DECISIONS_ENABLED: 'true',
    LIVE_PAPER_EXECUTION_ENABLED: 'true',
    FREE_PAPER_ACCOUNT_NAME: name,
  });
  const input = freeSnapshot(config, 14),
    profile = freePaperProfile(config, input.receivedAt);
  const strategy = createStrategyRepository(database.db),
    paper = createPaperRepository(database.db);
  await strategy.begin(profile.run);
  await paper.initialize(
    profile.definition,
    initialPortfolio(profile.definition),
    initialPosting(profile.definition),
  );
  const assessment = (
    await currentStrategyRisks(
      database.db,
      input.receivedAt,
      policyHash(riskPolicy(config)),
      100,
    )
  )[0]!;
  let state = initialStrategyState();
  for (const end of [12, 13, 14]) {
    const snapshot = freeSnapshot(config, end);
    const decision = evaluateFreePaperSnapshot(
      config,
      profile.run.id,
      snapshot,
      end === 14
        ? {
            currentStatus: 'ELIGIBLE',
            currentRequestId: assessment.requestId,
            assessment,
            availableAt: input.receivedAt,
          }
        : fixtureRisk(config, snapshot.receivedAt),
      state,
      snapshot.receivedAt,
    );
    await strategy.save(profile.run, decision, snapshot.candles, []);
    state = decision.stateAfter;
  }
  return { config, input, profile, paper };
}

it('rejects an expired entry without inventing a quote or changing cash', async () => {
  const { config, input, profile, paper } = await seedExecutableProfile(
    'integration-expired-execution',
  );
  const at = new Date(Date.parse(input.receivedAt) + 61000).toISOString();
  const lease = await database.acquireForwardOwnership(profile.definition.id);
  try {
    await createFreePaperExecutor(profile.definition, logger, () => at).expire(
      lease.db,
    );
    const snapshot = await paper.snapshot(profile.definition.id, {
      readOnly: true,
    });
    expect(snapshot.state.availableCashUsd).toBe(
      config.INITIAL_PAPER_BALANCE_USD,
    );
    expect(snapshot.state.positions).toEqual([]);
    expect(snapshot.events.at(-1)!.result.outcome).toBe('ENTRY_REJECTED');
    expect(snapshot.events.at(-1)!.result.reasons).toContain(
      'SIGNAL_STALE_OR_FUTURE',
    );
  } finally {
    lease.release();
  }
});

it('worker startup fills pending entries and keeps monitoring the original pool after entry eligibility expires', async () => {
  const { config, input, profile, paper } = await seedExecutableProfile(
    'integration-worker-execution',
  );
  let at = new Date(Date.parse(input.receivedAt) + 10000).toISOString();
  const read = vi
    .fn()
    .mockImplementation(async () => executionSnapshot(config, at));
  let service = createFreePaperDecisionService(config, database, logger, {
    client: { read },
    now: () => Date.parse(at),
  });
  const original = (
    await database.db
      .select()
      .from(tokens)
      .where(eq(tokens.mintAddress, input.mint))
  )[0]!.discoveredAt;
  try {
    await service.start();
    await vi.waitFor(
      async () =>
        expect(
          (await paper.load(profile.definition.id)).state.positions,
        ).toHaveLength(1),
      { timeout: 10000 },
    );
    await service.stop();
    await database.db
      .update(tokens)
      .set({ discoveredAt: '2000-01-01T00:00:00.000Z' })
      .where(eq(tokens.mintAddress, input.mint));
    at = new Date(Date.parse(at) + 10000).toISOString();
    read.mockImplementation(async () => executionSnapshot(config, at, '0.5'));
    service = createFreePaperDecisionService(config, database, logger, {
      client: { read },
      now: () => Date.parse(at),
    });
    await service.start();
    await vi.waitFor(
      async () =>
        expect(
          (await paper.load(profile.definition.id)).state.positions[0]!
            .pendingExitReason,
        ).toBe('STOP_LOSS'),
      { timeout: 10000 },
    );
    expect(read.mock.calls.at(-1)![2]).toBe(input.pool);
    await service.stop();
    at = new Date(Date.parse(at) + 10000).toISOString();
    service = createFreePaperDecisionService(config, database, logger, {
      client: { read },
      now: () => Date.parse(at),
    });
    await service.start();
    await vi.waitFor(
      async () =>
        expect(
          (await paper.load(profile.definition.id)).state.positions[0]!.status,
        ).toBe('CLOSED'),
      { timeout: 10000 },
    );
    await service.stop();
    expect(
      (await paper.snapshot(profile.definition.id, { readOnly: true })).state
        .reservedCashUsd,
    ).toBe('0');
  } finally {
    await service.stop();
    await database.db
      .update(tokens)
      .set({ discoveredAt: original })
      .where(eq(tokens.mintAddress, input.mint));
  }
});
