import { paperReplaySchema, stableId } from '@solemn/shared';
import type { ExecutionObservation } from '@solemn/shared';
import type { Config } from '../config/index.js';
import { createReplayFixture, replayTime } from '../strategy/replayFixture.js';
export function createPaperReplayFixture(
  config: Config,
  scenario: 'profit-targets' | 'blocked-stop' = 'profit-targets',
) {
  const dataset = createReplayFixture(config);
  dataset.markets = dataset.markets.slice(0, 1);
  const market = dataset.markets[0]!;
  const observation = (
    key: string,
    minute: number,
    priceUsd: string,
    side: 'BUY' | 'SELL' = 'SELL',
    liquidityUsd = '50000',
  ): ExecutionObservation => ({
    id: stableId(['week5-fictional-execution', scenario, key]),
    mint: market.mint,
    poolAddress: market.poolAddress,
    side,
    observedAt: replayTime(minute, 5000),
    receivedAt: replayTime(minute, 5000),
    priceUsd,
    liquidityUsd,
    estimatedPriceImpactPercent: null,
    usdReliable: true,
    healthy: true,
    usdSource: 'FICTIONAL_USD_QUOTE',
    source: 'SOLEMN_PAPER_FIXTURE',
    sourceTradeId: null,
    dataMode: 'FIXTURE',
    simulationOutcome: 'FULL_FILL',
  });
  const observations = [
    observation('entry', 14, '124', 'BUY'),
    observation('initial-mark', 15, '124'),
  ];
  if (scenario === 'profit-targets')
    observations.push(
      observation('target-1', 16, '210'),
      observation('target-2', 17, '350'),
      observation('new-high', 18, '400'),
      observation('trailing-exit', 19, '270'),
    );
  else
    observations.push(
      observation('stop-with-no-liquidity', 16, '80', 'SELL', '0'),
    );
  return paperReplaySchema.parse({
    format: 'SOLEMN_PAPER_REPLAY_V1',
    name: `Week 5 fictional ${scenario}`,
    marketDataset: dataset,
    observations,
  });
}
