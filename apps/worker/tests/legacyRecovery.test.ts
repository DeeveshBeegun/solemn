import { expect, it } from 'vitest';
import { stableHash, stableId } from '@solemn/shared';
import { runBacktest } from '../src/backtesting/replayEngine.js';
import { executionScenario } from '../src/execution/simulation/executionScenarios.js';
import { createForwardReplayFixture } from '../src/forward/replayProvider.js';
import { recoverPortfolio } from '../src/portfolio/recovery.js';
import { backtestConfig, backtestSetup } from './backtestFixtures.js';

it('recovers pre-revision synthetic audit references while verifying every economic field', async () => {
  const execution = { ...executionScenario('baseline') };
  delete execution.revision;
  const fixture = createForwardReplayFixture(backtestConfig);
  const setup = await backtestSetup('winner', fixture, { execution });
  const result = await runBacktest(
    setup.plan,
    setup.provider,
    backtestConfig,
    setup.services,
  );
  const repository = setup.services.paper;
  const snapshot = await repository.snapshot(result.finalState.id);
  const buy = snapshot.events
    .flatMap((event) => event.orders)
    .find((record) => record.order.side === 'BUY' && record.audit?.updatedPool);
  if (!buy?.audit?.updatedPool) throw new Error('Expected a modeled buy fill');
  const pool = buy.audit.updatedPool;
  pool.id = stableId(['legacy-opaque-pool-id']);
  for (const row of snapshot.events)
    for (const record of row.orders)
      if (record.audit) {
        delete record.audit.signalId;
        delete record.audit.positionId;
        if (record.order.side === 'SELL' && record.audit.updatedPool)
          record.audit.updatedPool.id = stableId([
            'legacy-sell-pool',
            record.order.id,
          ]);
      }
  const rehash = () => {
    let previousHash: string | null = null;
    for (const row of snapshot.events) {
      row.previousHash = previousHash;
      const { eventHash: _old, ...fields } = row;
      void _old;
      row.eventHash = stableHash(fields);
      previousHash = row.eventHash;
    }
  };
  rehash();
  expect(
    (await recoverPortfolio(repository, result.finalState.id, snapshot)).state,
  ).toEqual(snapshot.state);
  pool.quoteReserve = '1';
  rehash();
  await expect(
    recoverPortfolio(repository, result.finalState.id, snapshot),
  ).rejects.toThrow('history replay mismatch');
}, 15000);
