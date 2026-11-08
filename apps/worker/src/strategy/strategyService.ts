import {
  currentStrategyRisks,
  createStrategyRepository,
  strategyRun,
} from '@solemn/database';
import type { Database, StrategyRepository } from '@solemn/database';
import { stableId, strategyDecisionSchema } from '@solemn/shared';
import type { TokenRiskAssessment } from '@solemn/shared';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { safeError } from '../services/logger.js';
import { policyHash, riskPolicy } from '../risk/tokenRiskEngine.js';
import { initialStrategyState, strategyPolicy } from './signalEngine.js';
import { readReplayFile, replayStrategy } from './replay.js';

export function createStrategyService(
  config: Config,
  db: Database,
  logger: Logger,
  dependencies?: {
    repository?: StrategyRepository;
    eligible?: (now: string) => Promise<TokenRiskAssessment[]>;
  },
) {
  const repository = dependencies?.repository ?? createStrategyRepository(db);
  const riskHash = policyHash(riskPolicy(config));
  const run = strategyRun(strategyPolicy(config), riskHash, null);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined,
    running: Promise<void> | undefined,
    stopped = false,
    started = false;
  let status = 'DISABLED';
  async function poll(): Promise<void> {
    const now = new Date().toISOString();
    const candidates = await (dependencies?.eligible?.(now) ??
      currentStrategyRisks(
        db,
        now,
        riskHash,
        config.MARKET_DATA_MAX_TRACKED_TOKENS,
      ));
    for (const assessment of candidates.slice(
      0,
      config.MARKET_DATA_MAX_TRACKED_TOKENS,
    )) {
      if (stopped) return;
      const state = initialStrategyState();
      const decision = strategyDecisionSchema.parse({
        id: stableId(['live-not-ready', run.id, assessment.id]),
        runId: run.id,
        mint: assessment.tokenMint,
        poolAddress: null,
        timestamp: now,
        candleId: null,
        outcome: 'INSUFFICIENT_DATA',
        reasons: ['LIVE_MARKET_DATA_NOT_READY'],
        explanation:
          'No individual-trade feed with coverage is configured. Token creation events and Jupiter aggregates cannot supply minute momentum.',
        features: null,
        stateBefore: state,
        stateAfter: state,
        transitions: [],
        risk: {
          currentStatus: 'ELIGIBLE',
          currentRequestId: assessment.requestId,
          assessment,
          availableAt: now,
        },
        sourceRefs: [assessment.id],
        candidate: null,
      });
      const persisted = await repository.save(run, decision, [], []);
      logger.info(
        {
          mint: assessment.tokenMint,
          assessmentId: assessment.id,
          duplicate: persisted === 'DUPLICATE',
          status,
        },
        persisted === 'DUPLICATE'
          ? 'Duplicate strategy decision suppressed'
          : 'Market data insufficient; live strategy NOT_READY',
      );
    }
  }
  function schedule() {
    if (stopped) return;
    running = poll()
      .catch((error: unknown) =>
        logger.error(safeError(error), 'Strategy evaluation error'),
      )
      .finally(() => {
        if (!stopped)
          timer = setTimeout(schedule, config.STRATEGY_POLL_INTERVAL_MS);
      });
  }
  return {
    get status() {
      return status;
    },
    async start() {
      if (started || stopped) return;
      started = true;
      status = config.STRATEGY_FIXTURE_PATH ? 'FIXTURE_REPLAY' : 'NOT_READY';
      logger.info(
        {
          strategy: config.STRATEGY_ID,
          status,
          maxTrackedTokens: config.MARKET_DATA_MAX_TRACKED_TOKENS,
          paidTradeStream: false,
        },
        'Solemn strategy engine started',
      );
      if (config.STRATEGY_FIXTURE_PATH) {
        running = (async () => {
          const input = await readReplayFile(config.STRATEGY_FIXTURE_PATH);
          if (!stopped)
            await replayStrategy(
              input,
              config,
              repository,
              logger,
              controller.signal,
            );
        })()
          .then(() => {
            status = stopped ? 'STOPPED' : 'REPLAY_COMPLETE';
          })
          .catch((error: unknown) => {
            status = 'ERROR';
            logger.error(safeError(error), 'Strategy replay error');
          });
      } else {
        await repository.begin(run);
        if (!stopped) schedule();
      }
    },
    async stop() {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      await running;
      status = 'STOPPED';
    },
  };
}
