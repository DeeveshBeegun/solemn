import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { stableId } from '@solemn/shared';
import type { Database } from '@solemn/database';
import { createPaperTradingService } from '../src/portfolio/paperTradingService.js';
import { createWorker } from '../src/services/worker.js';
import { paperConfig } from './paperFixtures.js';
const logger = pino({ level: 'silent' });
describe('paper worker lifecycle', () => {
  it('reports forward NOT_READY without an explicit complete fixture and opt-in', async () => {
    const service = createPaperTradingService(
      { ...paperConfig, PAPER_ALLOW_FIXTURE_SIGNALS: false },
      {} as Database,
      logger,
    );
    await service.start();
    expect(service.status).toBe('NOT_READY');
    await service.stop();
    expect(service.status).toBe('STOPPED');
  });
  it('fails closed on an unreadable replay without running scanner callbacks or inventing trades', async () => {
    const service = createPaperTradingService(
      {
        ...paperConfig,
        PAPER_REPLAY_PATH: '/private/tmp/solemn-nonexistent-week5.json',
        PAPER_PORTFOLIO_ID: stableId(['brand-new-worker-portfolio']),
      },
      {} as Database,
      logger,
    );
    await service.start();
    await vi.waitFor(() => expect(service.status).toBe('ERROR'));
    await service.stop();
  });
  it('drains paper processing before strategy, scanner, risk and database even on failure', async () => {
    const order: string[] = [];
    const service = (name: string) => ({
      status: 'RUNNING',
      start: async () => {},
      stop: async () => {
        order.push(name);
      },
    });
    const worker = createWorker(
      {
        ...paperConfig,
        PAPER_TRADING_ENABLED: true,
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
      service('scanner'),
      service('risk'),
      service('strategy'),
      {
        ...service('paper'),
        stop: async () => {
          order.push('paper');
          throw new Error('paper drain failed');
        },
      },
    );
    await worker.start();
    await expect(worker.stop()).rejects.toThrow('paper drain failed');
    expect(order).toEqual(['paper', 'strategy', 'scanner', 'risk', 'database']);
  });
});
