import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@solemn/database';
import { loadConfig } from '../src/config/index.js';
import { createStrategyService } from '../src/strategy/strategyService.js';
import { createWorker } from '../src/services/worker.js';
import { createReplayFixture } from '../src/strategy/replayFixture.js';
import {
  strategyConfig,
  memoryStrategyRepository,
} from './strategyFixtures.js';
const logger = pino({ level: 'silent' });
describe('bounded strategy worker integration', () => {
  it('remains NOT_READY for real eligible tokens without a trade feed, caps work and drains safely', async () => {
    const store = memoryStrategyRepository(),
      assessment =
        createReplayFixture(strategyConfig).markets[0]!.risks[0]!.assessment!;
    const eligible = vi.fn().mockResolvedValue([assessment, assessment]);
    const service = createStrategyService(
      { ...strategyConfig, MARKET_DATA_MAX_TRACKED_TOKENS: 1 },
      {} as Database,
      logger,
      { repository: store.repository, eligible },
    );
    await service.start();
    await vi.waitFor(() => expect(store.decisions.size).toBe(1));
    expect(service.status).toBe('NOT_READY');
    expect([...store.decisions.values()][0]).toMatchObject({
      outcome: 'INSUFFICIENT_DATA',
      reasons: ['LIVE_MARKET_DATA_NOT_READY'],
      candidate: null,
    });
    await service.stop();
    expect(service.status).toBe('STOPPED');
    expect(eligible).toHaveBeenCalledTimes(1);
  });
  it('stops strategy, scanner, risk, database even when strategy shutdown fails', async () => {
    const order: string[] = [];
    const worker = createWorker(
      {
        ...strategyConfig,
        STRATEGY_ENABLED: true,
        SCANNER_ENABLED: true,
        TOKEN_RISK_ANALYSIS_ENABLED: true,
      },
      {
        verify: async () => {},
        close: async () => {
          order.push('database');
        },
      },
      logger,
      {
        status: 'CONNECTED',
        start: async () => {},
        stop: async () => {
          order.push('scanner');
        },
      },
      {
        start: async () => {},
        stop: async () => {
          order.push('risk');
        },
      },
      {
        status: 'NOT_READY',
        start: async () => {},
        stop: async () => {
          order.push('strategy');
          throw new Error('drain failed');
        },
      },
    );
    await worker.start();
    await expect(worker.stop()).rejects.toThrow('drain failed');
    expect(order).toEqual(['strategy', 'scanner', 'risk', 'database']);
  });
  it('defaults offline and rejects paid streams, invalid limits and time windows', () => {
    expect(strategyConfig.STRATEGY_ENABLED).toBe(false);
    for (const overrides of [
      { ENABLE_PAID_TRADE_STREAM: 'true' },
      { MARKET_DATA_PROVIDER: 'PUMPPORTAL' },
      { MARKET_DATA_MAX_TRACKED_TOKENS: '0' },
      { STRATEGY_MAX_POOL_AGE_MINUTES: '1' },
      { MARKET_DATA_ALLOWED_LATENESS_MS: '30001' },
      { STRATEGY_MIN_VOLUME_ACCELERATION: '0' },
    ])
      expect(() =>
        loadConfig({ DATABASE_URL: strategyConfig.DATABASE_URL, ...overrides }),
      ).toThrow();
  });
});
