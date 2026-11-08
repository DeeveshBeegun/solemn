import type { Logger } from 'pino';
import type { RiskRepository } from '@solemn/database';
import type { RiskJob } from '@solemn/shared';
import type { Config } from '../config/index.js';
import { safeError } from '../services/logger.js';
import { evaluateTokenRisk, riskPolicy } from '../risk/tokenRiskEngine.js';
import { JupiterTokenClient } from './jupiterTokenClient.js';
import type { JupiterClient } from './jupiterTokenClient.js';
import { TokenSecurityClient } from './tokenSecurity.js';
import type { SecurityClient } from './tokenSecurity.js';
import { emptyJupiter, emptySecurity } from './observations.js';

export function createRiskAnalysisService(
  config: Config,
  repository: RiskRepository,
  logger: Logger,
  dependencies: {
    jupiter?: JupiterClient;
    security?: SecurityClient;
    now?: () => number;
  } = {},
) {
  const now = dependencies.now ?? Date.now;
  const counters = {
    tokensAnalyzed: 0,
    eligible: 0,
    rejected: 0,
    unknown: 0,
    enrichmentFailures: 0,
    rpcFailures: 0,
    rateLimitEvents: 0,
    reassessments: 0,
    processingLatencyMs: 0,
  };
  const rateLimited = () => {
    counters.rateLimitEvents++;
    logger.warn('Risk provider rate limit response');
  };
  const jupiter =
    dependencies.jupiter ??
    new JupiterTokenClient(config, fetch, rateLimited, now);
  const security =
    dependencies.security ??
    new TokenSecurityClient(config, fetch, rateLimited, now);
  const policy = riskPolicy(config);
  const abort = new AbortController();
  let started = false,
    stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<number> | undefined;

  async function analyze(jobs: RiskJob[]): Promise<void> {
    const began = now();
    for (const job of jobs) {
      logger.info(
        { mint: job.tokenMint, attempt: job.attempt, trigger: job.trigger },
        'Token enrichment started',
      );
      if (job.attempt > 1 || job.trigger === 'TOKEN_MIGRATED')
        counters.reassessments++;
      if (['TOKEN_MIGRATED', 'MANUAL'].includes(job.trigger))
        jupiter.invalidate(job.tokenMint);
    }
    const mints = jobs.map((job) => job.tokenMint);
    const [metadataResult, securityResult] = await Promise.allSettled([
      jupiter.getMany(mints, abort.signal),
      security.getMany(mints, abort.signal),
    ]);
    const time = new Date(now()).toISOString();
    const persistenceResults = await Promise.allSettled(
      jobs.map(async (job) => {
        const metadata =
          metadataResult.status === 'fulfilled'
            ? metadataResult.value.get(job.tokenMint)
            : undefined;
        const mint =
          securityResult.status === 'fulfilled'
            ? securityResult.value.get(job.tokenMint)
            : undefined;
        const missingError = {
          code: 'NETWORK' as const,
          httpStatus: null,
          retryAt: null,
        };
        const enrichment = metadata ?? {
          ...emptyJupiter(job.tokenMint, time),
          state: 'ERROR' as const,
          error: missingError,
        };
        const onChain = mint ?? {
          ...emptySecurity(job.tokenMint, time),
          state: 'ERROR' as const,
          error: missingError,
        };
        if (enrichment.state !== 'OK') {
          counters.enrichmentFailures++;
          logger.warn(
            {
              mint: job.tokenMint,
              code: enrichment.error?.code ?? 'NOT_INDEXED',
            },
            'Enrichment source unavailable',
          );
        } else
          logger.info({ mint: job.tokenMint }, 'Token enrichment completed');
        if (onChain.state !== 'OK') {
          counters.rpcFailures++;
          logger.warn(
            { mint: job.tokenMint, code: onChain.error?.code ?? 'NOT_FOUND' },
            'RPC security source unavailable',
          );
        } else
          logger.info({ mint: job.tokenMint }, 'RPC security checks completed');
        const assessment = evaluateTokenRisk(
          job,
          enrichment,
          onChain,
          policy,
          time,
        );
        if (
          !assessment.checks.liquidityFresh ||
          assessment.checks.liquidityUsd === null
        )
          logger.warn(
            { mint: job.tokenMint },
            'Liquidity information unavailable or stale',
          );
        let nextAt: string | null = null;
        if (job.attempt < config.RISK_ANALYSIS_RETRY_LIMIT) {
          const expiry =
            assessment.status === 'ELIGIBLE' && assessment.validUntil
              ? Date.parse(assessment.validUntil)
              : Infinity;
          const serverRetry = Math.max(
            0,
            ...[enrichment.error?.retryAt, onChain.error?.retryAt]
              .filter((value): value is string => value != null)
              .map(Date.parse),
          );
          nextAt = new Date(
            Math.max(
              serverRetry,
              Math.min(expiry, now() + config.RISK_REASSESS_INTERVAL_MS),
            ),
          ).toISOString();
        }
        const persistence = await repository.persist(assessment, nextAt);
        counters.tokensAnalyzed++;
        counters[
          assessment.status === 'ELIGIBLE'
            ? 'eligible'
            : assessment.status === 'REJECTED'
              ? 'rejected'
              : 'unknown'
        ]++;
        logger.info(
          {
            mint: job.tokenMint,
            assessmentId: assessment.id,
            status: assessment.status,
            reasons: assessment.reasons,
            persistence,
          },
          'Token risk assessment persisted',
        );
        if (nextAt !== null)
          logger.info(
            { mint: job.tokenMint, nextAt },
            'Bounded reassessment scheduled',
          );
      }),
    );
    const failures = persistenceResults.filter(
      (result) => result.status === 'rejected',
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Risk persistence failed; leases remain recoverable and eligibility is not asserted',
      );
    counters.processingLatencyMs = now() - began;
  }

  function runOnce(mint?: string): Promise<number> {
    if (!config.TOKEN_RISK_ANALYSIS_ENABLED || stopping)
      return Promise.resolve(0);
    if (running) return running;
    running = (async () => {
      const time = new Date(now()).toISOString();
      await repository.expire(time);
      const jobs = await repository.claim(
        config.RISK_ANALYSIS_CONCURRENCY,
        time,
        config.RISK_JOB_LEASE_MS,
        config.RISK_ANALYSIS_RETRY_LIMIT,
        mint,
      );
      if (jobs.length) await analyze(jobs);
      return jobs.length;
    })().finally(() => {
      running = undefined;
    });
    return running;
  }
  const kick = () => {
    void runOnce().catch((error: unknown) =>
      logger.error(
        safeError(error),
        'Risk analysis worklist failed; tokens remain UNKNOWN until recovery',
      ),
    );
  };
  return {
    runOnce,
    metrics: () => ({ ...counters, activeBatch: running !== undefined }),
    notify(mint: string, migration = false) {
      if (!config.TOKEN_RISK_ANALYSIS_ENABLED || stopping) return;
      if (migration) jupiter.invalidate(mint);
      logger.info(
        { mint, reassessment: migration },
        migration
          ? 'Migration reassessment requested'
          : 'Token queued for risk analysis',
      );
      if (started) kick();
    },
    async start(): Promise<void> {
      if (started || stopping || !config.TOKEN_RISK_ANALYSIS_ENABLED) return;
      started = true;
      logger.info(
        {
          concurrency: config.RISK_ANALYSIS_CONCURRENCY,
          attemptsPerRequest: config.RISK_ANALYSIS_RETRY_LIMIT,
        },
        'Solemn risk engine started',
      );
      timer = setInterval(() => {
        logger.debug(counters, 'Solemn risk metrics');
        kick();
      }, config.RISK_POLL_INTERVAL_MS);
      kick();
    },
    async stop(): Promise<void> {
      stopping = true;
      clearInterval(timer);
      abort.abort();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          running,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    'Risk shutdown deadline exceeded; leased work remains recoverable',
                  ),
                ),
              config.RISK_SHUTDOWN_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (error) {
        logger.error(
          safeError(error),
          'Risk shutdown failed; current eligibility is not asserted',
        );
        await running?.catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timeout);
        logger.info(counters, 'Solemn risk engine stopped');
      }
    },
  };
}
