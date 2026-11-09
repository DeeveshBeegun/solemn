import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createPaperRepository,
  createStrategyRepository,
  forwardAccounts,
  forwardOwnerPid,
  forwardRuntimeEvents,
} from '@solemn/database';
import type { Database, StrategyRun } from '@solemn/database';
import {
  paperAccountDefinitionSchema,
  stableHash,
  stableId,
} from '@solemn/shared';
import type {
  PaperAccountDefinition,
  PaperPortfolioState,
} from '@solemn/shared';
import { executionScenario } from '../execution/simulation/executionScenarios.js';
import {
  initialPortfolio,
  initialPosting,
} from '../portfolio/accountingService.js';
import { paperPolicy } from '../portfolio/policy.js';
import { policyHash, riskPolicy } from '../risk/tokenRiskEngine.js';
import { strategyPolicy } from '../strategy/signalEngine.js';
import type { Config } from '../config/index.js';
import { assertPaperMode } from '../security/securityPolicy.js';
import {
  auditOperation,
  runtimeState,
  transitionOperations,
} from '../operations/operationalController.js';
import { engageKillSwitch } from '../operations/killSwitch.js';

export const forwardPortfolioId = (config: Config) =>
  stableId([
    'solemn-forward-v1',
    config.FORWARD_MARKET_DATA_MODE,
    config.FORWARD_MARKET_DATA_MODE === 'REPLAY'
      ? config.FORWARD_ACCOUNT
      : 'live',
  ]);
export type ForwardAccount = typeof forwardAccounts.$inferSelect;

export async function recordForwardEvent(
  db: Database,
  account: Pick<ForwardAccount, 'portfolioId' | 'sessionId'>,
  kind: string,
  key: string,
  at: string,
  details: Record<string, unknown>,
) {
  await db
    .insert(forwardRuntimeEvents)
    .values({
      id: stableId([
        'forward-runtime-event-v1',
        account.portfolioId,
        kind,
        key,
      ]),
      portfolioId: account.portfolioId,
      sessionId: account.sessionId,
      kind,
      at,
      details,
    })
    .onConflictDoNothing();
}
export async function lockForwardAccount(db: Database, id: string) {
  const account = (
    await db
      .select()
      .from(forwardAccounts)
      .where(eq(forwardAccounts.portfolioId, id))
      .for('update')
  )[0];
  if (!account) throw new Error('Forward account has not been initialized');
  return account;
}

export async function initializeForwardAccount(
  db: Database,
  config: Config,
  source: { fingerprint: string; start: string },
  initialCheckpoint: unknown,
) {
  assertPaperMode(config);
  const id = forwardPortfolioId(config),
    replay = config.FORWARD_MARKET_DATA_MODE === 'REPLAY';
  const strategy = strategyPolicy(config),
    risk = riskPolicy(config),
    policy = paperPolicy(config);
  const execution = replay
    ? {
        ...executionScenario('baseline'),
        maxQuoteAgeMs: config.FORWARD_MAX_MARKET_DATA_AGE_SECONDS * 1000,
      }
    : undefined;
  const profileHash = stableHash({
    version: 'solemn-forward-v1',
    mode: config.FORWARD_MARKET_DATA_MODE,
    source: source.fingerprint,
    strategy,
    risk,
    policy,
    execution: execution ?? null,
    maxTracked: config.FORWARD_MAX_TRACKED_TOKENS,
    freshness: config.FORWARD_MAX_MARKET_DATA_AGE_SECONDS,
    cadence: config.FORWARD_EQUITY_SNAPSHOT_INTERVAL_SECONDS,
  });
  const strategyRun: StrategyRun = {
    id: stableId(['forward-strategy-v1', id]),
    mode: replay ? 'FIXTURE' : 'LIVE_NOT_READY',
    strategyId: strategy.strategyId,
    strategyVersion: strategy.version,
    configHash: stableHash(strategy),
    riskPolicyHash: policyHash(risk),
    config: strategy,
    datasetHash: replay ? source.fingerprint : null,
    dataset: null,
  };
  const definitionData = {
    policy,
    strategyPolicy: strategy,
    riskPolicy: risk,
    strategyRunId: strategyRun.id,
    replayHash: profileHash,
    ...(execution ? { forwardExecution: execution } : {}),
  };
  const definition = paperAccountDefinitionSchema.parse({
    ...definitionData,
    id,
    name: replay
      ? `forward-replay-${config.FORWARD_ACCOUNT}`
      : 'forward-live-read-only',
    mode: 'PAPER',
    currency: 'USD',
    dataMode: replay ? 'FORWARD_REPLAY' : 'FORWARD_LIVE',
    createdAt: source.start,
    configHash: stableHash(definitionData),
  });
  const wall = new Date().toISOString(),
    sessionId = randomUUID();
  const account = await db.transaction(async (tx) => {
    const ownerPid = await forwardOwnerPid(tx, id);
    if (!ownerPid)
      throw new Error(
        'Forward startup requires the PostgreSQL ownership session',
      );
    const existing = (
      await tx
        .select()
        .from(forwardAccounts)
        .where(eq(forwardAccounts.portfolioId, id))
        .for('update')
    )[0];
    if (existing && existing.profileHash !== profileHash)
      throw new Error(
        'Forward profile changed. Restore its configuration or select a new replay account.',
      );
    if (!existing) {
      await createStrategyRepository(tx).begin(strategyRun);
      await createPaperRepository(tx).initialize(
        definition,
        initialPortfolio(definition),
        initialPosting(definition),
      );
      await tx.insert(forwardAccounts).values({
        portfolioId: id,
        mode: config.FORWARD_MARKET_DATA_MODE,
        profileHash,
        status: 'STARTING',
        opsReason: 'WORKER_STARTING',
        opsActor: 'worker',
        ownerPid,
        sessionId,
        startedAt: wall,
        heartbeatAt: wall,
        checkpoint: initialCheckpoint,
      });
    }
    let account = (
      await tx
        .update(forwardAccounts)
        .set({
          ownerPid,
          health: null,
          sessionId,
          startedAt: wall,
          heartbeatAt: wall,
        })
        .where(eq(forwardAccounts.portfolioId, id))
        .returning()
    )[0]!;
    await auditOperation(tx, account, {
      kind: 'WORKER_STARTED',
      key: sessionId,
      at: wall,
      reason: existing ? 'WORKER_RESTARTED' : 'WORKER_STARTED',
      actor: 'worker',
      source: 'WORKER',
      severity: 'INFO',
    });
    if (existing?.ownerPid)
      account = await engageKillSwitch(tx, account, 'UNCLEAN_FORWARD_SHUTDOWN');
    account = await transitionOperations(
      tx,
      account,
      runtimeState(account.status, 'RECOVERING'),
      'RECOVERING_LEDGER',
      'worker',
      'WORKER',
    );
    await recordForwardEvent(tx, account, 'SESSION_STARTED', sessionId, wall, {
      mode: account.mode,
      strategyVersion: strategy.version,
      restarting: !!existing,
    });
    return account;
  });
  return { account, strategyRun };
}
export async function beginForwardShutdown(
  db: Database,
  account: ForwardAccount,
) {
  await db.transaction(async (tx) => {
    const row = await lockForwardAccount(tx, account.portfolioId);
    if (
      row.sessionId !== account.sessionId ||
      !row.ownerPid ||
      (await forwardOwnerPid(tx, row.portfolioId)) !== row.ownerPid
    )
      throw new Error('Forward shutdown lost ownership');
    await transitionOperations(
      tx,
      row,
      runtimeState(row.status, 'STOPPING'),
      'WORKER_DRAINING',
      'worker',
      'WORKER',
    );
  });
}

export async function finishForwardSession(
  db: Database,
  account: ForwardAccount,
  status: 'STOPPED' | 'HALTED',
  reason: string,
) {
  const at = new Date().toISOString();
  await db.transaction(async (tx) => {
    let row = await lockForwardAccount(tx, account.portfolioId);
    if (
      row.sessionId !== account.sessionId ||
      !row.ownerPid ||
      (await forwardOwnerPid(tx, row.portfolioId)) !== row.ownerPid
    )
      return;
    if (status === 'HALTED') row = await engageKillSwitch(tx, row, reason);
    else {
      row = await transitionOperations(
        tx,
        row,
        runtimeState(row.status, 'STOPPING'),
        'WORKER_DRAINING',
        'worker',
        'WORKER',
      );
      row = await transitionOperations(
        tx,
        row,
        runtimeState(row.status, 'STOPPED'),
        reason,
        'worker',
        'WORKER',
      );
    }
    await tx
      .update(forwardAccounts)
      .set({ ownerPid: null, heartbeatAt: at })
      .where(eq(forwardAccounts.sessionId, row.sessionId));
    await recordForwardEvent(tx, row, 'SESSION_ENDED', row.sessionId, at, {
      status: row.status,
      reason,
    });
    await auditOperation(tx, row, {
      kind: 'WORKER_STOPPED',
      key: row.sessionId,
      at,
      reason,
      actor: 'worker',
      source: 'WORKER',
      severity: status === 'HALTED' ? 'CRITICAL' : 'INFO',
    });
  });
}
export const reliableEquity = (state: PaperPortfolioState) =>
  !state.executionUncertain &&
  state.positions.every(
    (p) =>
      p.status === 'CLOSED' ||
      (!p.valuationStale &&
        !p.liquidationUncertain &&
        p.status !== 'EXIT_BLOCKED'),
  );
export function equityDetails(
  state: PaperPortfolioState,
  definition: PaperAccountDefinition,
) {
  const reliable = reliableEquity(state);
  return {
    asOf: state.asOf,
    startingBalanceUsd: definition.policy.initialBalanceUsd,
    availableCashUsd: state.availableCashUsd,
    reservedCashUsd: state.reservedCashUsd,
    markedEquityUsd: reliable ? state.equityUsd : null,
    realizedNetPnlUsd: state.executionUncertain ? null : state.realizedPnlUsd,
    unrealizedPnlUsd: reliable ? state.unrealizedPnlUsd : null,
    currentDrawdownPercent: reliable ? state.drawdownPercent : null,
    peakEquityUsd: state.peakEquityUsd,
    netReturnPercent: reliable ? state.totalReturnPercent : null,
    valuationQuality: reliable ? 'RELIABLE' : 'UNCERTAIN',
  };
}
