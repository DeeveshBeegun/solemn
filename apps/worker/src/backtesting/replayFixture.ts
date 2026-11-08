import { getAddressDecoder } from '@solana/kit';
import {
  historicalFileSchema,
  compareHistoricalEvents,
  historyIdentity,
  multiplyDecimal,
  stableId,
  stableHash,
} from '@solemn/shared';
import type {
  FixtureMarket,
  HistoricalEvent,
  ExecutionObservation,
} from '@solemn/shared';
import type { Config } from '../config/index.js';
import { createReplayFixture, replayTime } from '../strategy/replayFixture.js';
import { evaluateTokenRisk, riskPolicy } from '../risk/tokenRiskEngine.js';
export const backtestCases = [
  'winner',
  'stop-loss',
  'liquidity-failure',
  'unsafe',
  'incomplete',
  'lookahead-trap',
] as const;
const at = (minute: number, milliseconds = 0) =>
  replayTime(minute, milliseconds);
export function createBacktestFixture(
  config: Config,
  selection: 'all' | 'winner' | 'zero-trade' = 'all',
) {
  const base = createReplayFixture(config),
    events: HistoricalEvent[] = [];
  const address = (seed: number) =>
    getAddressDecoder().decode(new Uint8Array(32).fill(seed));
  const markets = backtestCases.map((name, index) => {
    const source: FixtureMarket = structuredClone(
      index < 3
        ? base.markets[0]!
        : index === 3
          ? base.markets[2]!
          : index === 4
            ? base.markets[4]!
            : base.markets[1]!,
    );
    const mint = address(70 + index),
      poolAddress = address(80 + index);
    const market = {
      mint,
      poolAddress,
      quoteMint: source.quoteMint,
      poolCreatedAt: at(0),
      poolCreationAvailableAt: at(0),
    };
    const wrap = (
      kind: HistoricalEvent['kind'],
      sourceId: string,
      eventAt: string | null,
      availableAt: string,
      data: unknown,
    ) => {
      events.push({
        id: historyIdentity(kind, mint, poolAddress, sourceId),
        mint,
        poolAddress,
        kind,
        eventAt,
        availableAt,
        source: 'SOLEMN_WEEK6_SYNTHETIC',
        slot: null,
        transactionIndex: null,
        providerIndex: null,
        data,
      } as HistoricalEvent);
    };
    wrap('DISCOVERY', name, at(0), at(0), {
      eventType: 'TOKEN_CREATED',
      sourceEventId: name,
      rawPayload: { synthetic: true, scenario: name },
    });
    for (let minute = 0; minute < 20; minute++) {
      const originalMinute = Math.min(minute, 17);
      const originalTrades = source.trades.filter(
        (trade) =>
          trade.timestamp >= at(originalMinute) &&
          trade.timestamp < at(originalMinute + 1),
      );
      for (const [tick, original] of originalTrades.entries()) {
        const trade = structuredClone(original),
          sourceEventId = `week6:${name}:${minute}:${tick}`;
        trade.id = stableId(['market-trade', trade.source, sourceEventId]);
        trade.sourceEventId = sourceEventId;
        trade.mint = mint;
        trade.poolAddress = poolAddress;
        const milliseconds =
          Date.parse(original.timestamp) - Date.parse(at(originalMinute));
        trade.timestamp = at(minute, milliseconds);
        trade.receivedAt = at(minute, milliseconds + 100);
        trade.usdObservedAt = trade.timestamp;
        if (minute >= 14 && index < 3)
          trade.priceUsd =
            index === 0
              ? (['124', '210', '350', '400', '270', '270'][minute - 14] ??
                '270')
              : index === 1
                ? '80'
                : minute < 16
                  ? '150'
                  : '80';
        if (index === 5 && minute >= 17) trade.priceUsd = '1000';
        if (trade.priceUsd && trade.usdReliable) {
          trade.volumeUsd = multiplyDecimal(trade.tokenAmount, trade.priceUsd);
          trade.quoteAmount = trade.volumeUsd;
        }
        trade.rawPayload = { synthetic: true, scenario: name };
        wrap('TRADE', trade.id, trade.timestamp, trade.receivedAt, trade);
      }
      const oldCoverage = source.coverage[originalMinute]!,
        coverage = {
          ...oldCoverage,
          id: stableId(['week6-coverage', name, minute]),
          start: at(minute),
          end: at(minute + 1),
          availableAt: at(minute + 1, minute === 19 ? 0 : 1000),
        };
      // The dataset ends at 20:00; no coverage promise is made before it is available.
      if (Date.parse(coverage.availableAt) <= Date.parse(at(20)))
        wrap(
          'COVERAGE',
          coverage.id,
          coverage.end,
          coverage.availableAt,
          coverage,
        );
      const old = source.risks[originalMinute]!.assessment!,
        assessedAt = at(minute + 1, -1000),
        requestId = stableId(['week6-risk', name, minute]);
      const jupiter = {
        ...old.evidence.jupiter,
        mint,
        fetchedAt: assessedAt,
        updatedAt: assessedAt,
        liquidityUsd:
          index === 2 && minute >= 16 ? '0' : old.evidence.jupiter.liquidityUsd,
      };
      const solana = { ...old.evidence.solana, mint, checkedAt: assessedAt };
      const assessment = evaluateTokenRisk(
        {
          tokenMint: mint,
          requestId,
          requestedAt: assessedAt,
          attempt: 1,
          trigger: 'SYNTHETIC_HISTORY',
          previous: null,
        },
        jupiter,
        solana,
        riskPolicy(config),
        assessedAt,
      );
      const context = {
        currentStatus:
          index === 5 && minute < 16 ? ('UNKNOWN' as const) : assessment.status,
        currentRequestId: index === 5 && minute < 16 ? null : requestId,
        assessment,
        availableAt: assessedAt,
      };
      wrap('RISK', assessment.id, assessedAt, assessedAt, context);
    }
    const quote = (
      key: string,
      minute: number,
      milliseconds: number,
      priceUsd: string,
      side: 'BUY' | 'SELL',
      liquidityUsd = '50000',
    ) => {
      const observedAt = at(minute, milliseconds),
        observation: ExecutionObservation = {
          id: stableId(['week6-quote', name, key]),
          mint,
          poolAddress,
          side,
          observedAt,
          receivedAt: observedAt,
          priceUsd,
          liquidityUsd,
          estimatedPriceImpactPercent: null,
          usdReliable: true,
          healthy: true,
          usdSource: 'FICTIONAL_USD_QUOTE',
          source: 'SOLEMN_WEEK6_SYNTHETIC',
          sourceTradeId: null,
          dataMode: 'FIXTURE',
          simulationOutcome: 'FULL_FILL',
        };
      wrap('EXECUTION', observation.id, observedAt, observedAt, observation);
    };
    if (index < 3) {
      quote('entry', 14, 6000 + index * 200, '124', 'BUY');
      quote('initial-mark', 14, 6100 + index * 200, '124', 'SELL');
    }
    if (index === 0) {
      quote('tp1-trigger', 16, 5000, '210', 'SELL');
      quote('tp1-execute', 16, 6000, '210', 'SELL');
      quote('tp2-trigger', 17, 5000, '350', 'SELL');
      quote('tp2-execute', 17, 6000, '350', 'SELL');
      quote('peak', 18, 5000, '400', 'SELL');
      quote('trail-trigger', 19, 5000, '270', 'SELL');
      quote('trail-execute', 19, 6000, '270', 'SELL');
    }
    if (index === 1) {
      quote('stop-trigger', 15, 0, '80', 'SELL');
      quote('stop-execute', 15, 1000, '80', 'SELL');
    }
    if (index === 2) {
      quote('rise', 15, 10000, '150', 'SELL');
      quote('liquidity-gone-trigger', 16, 0, '80', 'SELL', '0');
      quote('liquidity-gone-execute', 16, 1000, '80', 'SELL', '0');
    }
    if (index === 5) quote('future-tempting-quote', 18, 5000, '1000', 'BUY');
    return market;
  });
  const selected =
    selection === 'winner'
      ? markets.slice(0, 1)
      : selection === 'zero-trade'
        ? markets.slice(3)
        : markets;
  const scopes = new Set(
    selected.map((market) => `${market.mint}:${market.poolAddress}`),
  );
  return historicalFileSchema.parse({
    manifest: {
      format: 'SOLEMN_HISTORY_V1',
      datasetId: `solemn-week6-${selection}`,
      version: `1.0.0-${stableHash(riskPolicy(config)).slice(0, 12)}`,
      name: `Week 6 six-scenario synthetic history (${selection})`,
      sourceKind: 'SYNTHETIC',
      provenance:
        'Fictional deterministic observations; no actual historical profitability claim.',
      startTime: at(0),
      endTime: at(20),
      orderingPolicy: 'AVAILABILITY_V1',
      markets: selected,
    },
    events: events
      .filter((event) => scopes.has(`${event.mint}:${event.poolAddress}`))
      .sort(compareHistoricalEvents),
  });
}
