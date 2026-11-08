import { analyzeHistory, stableId } from '@solemn/shared';
import type {
  BacktestResult,
  EquitySnapshot,
  ExecutionIntent,
  HistoricalFile,
  StoredDataset,
} from '@solemn/shared';
import type { BacktestRepository } from '@solemn/database';
import { createBacktestFixture } from '../src/backtesting/replayFixture.js';
import { createBacktestPlan } from '../src/backtesting/backtestConfig.js';
import {
  FixtureHistoricalDataProvider,
  historyEvents,
} from '../src/backtesting/historicalDataProvider.js';
import { paperConfig, memoryPaperRepository } from './paperFixtures.js';
import { memoryStrategyRepository } from './strategyFixtures.js';
export const backtestConfig = paperConfig;
export function memoryBacktestRepository() {
  const results = new Map<string, BacktestResult>(),
    snapshots = new Map<string, EquitySnapshot>(),
    intents = new Map<string, ExecutionIntent>();
  const paper = memoryPaperRepository();
  const repository: BacktestRepository = {
    async start(plan) {
      return results.get(plan.runId) ?? null;
    },
    async attach() {},
    async equity(snapshot) {
      snapshots.set(snapshot.id, structuredClone(snapshot));
    },
    async intent(intent) {
      const old = intents.get(intent.id);
      if (old && old.status !== 'PENDING' && intent.status === 'PENDING')
        return;
      intents.set(intent.id, structuredClone(intent));
    },
    async complete(result) {
      results.set(result.plan.runId, structuredClone(result));
    },
    async fail() {},
    async result(id) {
      const result = results.get(id);
      if (!result) throw new Error('Unknown backtest');
      return result;
    },
    async *equitySeries(id) {
      for (const snapshot of [...snapshots.values()]
        .filter((item) => item.runId === id)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)))
        yield snapshot;
    },
    async *intents(id) {
      for (const intent of intents.values())
        if (intent.runId === id) yield intent;
    },
    async *ledger(id) {
      for (const event of paper.events)
        if (event.portfolioId === id) yield event;
    },
  };
  return { repository, results, snapshots, intents, paper };
}
export async function backtestSetup(
  selection: 'all' | 'winner' | 'zero-trade' = 'all',
  input?: HistoricalFile,
  overrides: Record<string, unknown> = {},
) {
  const file = input ?? createBacktestFixture(backtestConfig, selection),
    analysis = await analyzeHistory(file.manifest, historyEvents(file.events));
  const dataset: StoredDataset = {
    id: stableId([
      'test-dataset',
      file.manifest.datasetId,
      file.manifest.version,
    ]),
    manifest: file.manifest,
    ...analysis,
  };
  const plan = createBacktestPlan(
      { dataset: 'fixtures', ...overrides },
      dataset,
      backtestConfig,
    ),
    store = memoryBacktestRepository(),
    strategy = memoryStrategyRepository();
  return {
    file,
    dataset,
    plan,
    store,
    strategy,
    provider: new FixtureHistoricalDataProvider(dataset, file),
    services: {
      paper: store.paper.repository,
      strategy: strategy.repository,
      backtests: store.repository,
    },
  };
}
