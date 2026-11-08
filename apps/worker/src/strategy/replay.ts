import { readFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { strategyRun } from '@solemn/database';
import type { StrategyRepository } from '@solemn/database';
import { stableHash } from '@solemn/shared';
import type { StrategyDecision } from '@solemn/shared';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { safeError } from '../services/logger.js';
import { ratioAtLeast } from './exactMath.js';
import { FixtureReplayProvider } from '../analysis/marketDataProvider.js';
import { CandleBuilder } from '../analysis/candleBuilder.js';
import { policyHash, riskPolicy } from '../risk/tokenRiskEngine.js';
import {
  evaluateSignal,
  initialStrategyState,
  strategyPolicy,
} from './signalEngine.js';

export async function readReplayFile(path: string): Promise<unknown> {
  if ((await stat(path)).size > 10 * 1024 * 1024)
    throw new Error('Replay file exceeds 10 MiB limit');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
export async function replayStrategy(
  input: unknown,
  config: Config,
  repository: StrategyRepository,
  logger?: Logger,
  signal?: AbortSignal,
) {
  const started = performance.now();
  const provider = new FixtureReplayProvider(
    input,
    config.MARKET_DATA_MAX_TRACKED_TOKENS,
  );
  const run = strategyRun(
    strategyPolicy(config),
    policyHash(riskPolicy(config)),
    provider.dataset,
  );
  const metrics = {
    tokensEvaluated: 0,
    blockedByRisk: 0,
    insufficientData: 0,
    buyCandidates: 0,
    duplicateDecisions: 0,
    indicatorErrors: 0,
    processingLatencyMs: 0,
  };
  const decisions: StrategyDecision[] = [];
  await repository.begin(run);
  const contexts = provider.dataset.markets.map((market) => ({
    market,
    builder: new CandleBuilder(
      market.mint,
      market.poolAddress,
      market.quoteMint,
      config.MARKET_DATA_ALLOWED_LATENESS_MS,
    ),
    delivered: new Set<string>(),
    state: initialStrategyState(),
  }));
  // Time-major iteration makes cross-market replay logs chronological as well.
  for (
    let end = Date.parse(provider.dataset.start) + 60000;
    end <= Date.parse(provider.dataset.end);
    end += 60000
  ) {
    for (const context of contexts) {
      if (signal?.aborted) return { run, decisions, metrics };
      const { market, builder, delivered } = context;
      const asOf = new Date(
          end + config.MARKET_DATA_ALLOWED_LATENESS_MS,
        ).toISOString(),
        candleEnd = new Date(end).toISOString();
      const trades = await provider.getRecentTrades(
        market.mint,
        market.poolAddress,
        provider.dataset.start,
        asOf,
      );
      for (const trade of trades) {
        const key = stableHash(trade);
        if (!delivered.has(key)) {
          builder.ingest(trade);
          delivered.add(key);
        }
      }
      const candles = [];
      for (
        let start = Math.max(
          Date.parse(provider.dataset.start),
          end - 16 * 60000,
        );
        start < end;
        start += 60000
      )
        candles.push(
          builder.build(new Date(start).toISOString(), asOf, market.coverage),
        );
      const current = candles.at(-1);
      const coverage = market.coverage.filter(
        (item) => Date.parse(item.availableAt) <= Date.parse(asOf),
      );
      const updates = [
        ...coverage.map((item) => item.availableAt),
        ...trades.map((trade) => trade.receivedAt),
      ].sort();
      const corrections = builder.visibleCorrections(asOf);
      const risk = provider.riskAt(market, asOf);
      let decision: StrategyDecision;
      try {
        decision = evaluateSignal(
          {
            runId: run.id,
            mint: market.mint,
            poolAddress: market.poolAddress,
            poolCreatedAt: market.poolCreatedAt,
            asOf,
            candleEnd,
            candles,
            risk,
            // Late gap reports preserve published candles but invalidate future affected windows.
            feedHealthy:
              (current?.complete ?? false) &&
              !coverage.some(
                (item) =>
                  item.kind === 'GAP' &&
                  Date.parse(item.availableAt) >
                    Date.parse(item.end) +
                      config.MARKET_DATA_ALLOWED_LATENESS_MS &&
                  Date.parse(item.end) > end - 10 * 60000 &&
                  Date.parse(item.start) < end,
              ),
            lastMarketUpdateAt: updates.at(-1) ?? null,
            corrections,
            sourceRefs: [
              ...candles.map((candle) => candle.id),
              ...candles.flatMap((candle) => candle.tradeIds),
              ...coverage.map((item) => item.id),
              ...corrections.map((item) => item.id),
              ...(risk?.assessment ? [risk.assessment.id] : []),
            ],
          },
          context.state,
          config,
        );
      } catch (error) {
        metrics.indicatorErrors++;
        logger?.error(
          { ...safeError(error), mint: market.mint, metrics },
          'Strategy indicator evaluation failed',
        );
        throw error;
      }
      const saved = await repository.save(
        run,
        decision,
        current ? [current] : [],
        corrections,
      );
      context.state = decision.stateAfter;
      decisions.push(decision);
      metrics.tokensEvaluated++;
      if (saved === 'DUPLICATE') metrics.duplicateDecisions++;
      if (decision.outcome === 'BLOCKED_BY_RISK') metrics.blockedByRisk++;
      if (decision.outcome === 'INSUFFICIENT_DATA') metrics.insufficientData++;
      if (decision.outcome === 'BUY_CANDIDATE') metrics.buyCandidates++;
      if (
        decision.features &&
        ratioAtLeast(
          decision.features.volumeAcceleration,
          config.STRATEGY_MIN_VOLUME_ACCELERATION,
        )
      )
        logger?.debug({ mint: market.mint }, 'Volume acceleration detected');
      if (
        decision.features &&
        ratioAtLeast(
          decision.features.buySellRatio,
          config.STRATEGY_MIN_BUY_SELL_RATIO,
        )
      )
        logger?.debug({ mint: market.mint }, 'Strong buying pressure detected');
      logger?.debug(
        { mint: market.mint, candleId: current?.id },
        'New finalized market candle',
      );
      logger?.info(
        {
          mint: market.mint,
          outcome: decision.outcome,
          reasons: decision.reasons,
          transitions: decision.transitions,
          duplicate: saved === 'DUPLICATE',
        },
        saved === 'DUPLICATE'
          ? 'Duplicate strategy decision suppressed'
          : 'Strategy decision persisted',
      );
    }
  }
  metrics.processingLatencyMs = Math.round(performance.now() - started);
  logger?.info(
    { runId: run.id, mode: run.mode, metrics },
    'Strategy replay completed',
  );
  return { run, decisions, metrics };
}
