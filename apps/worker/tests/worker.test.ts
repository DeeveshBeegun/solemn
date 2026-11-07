import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createWorker } from '../src/services/worker.js';

const config = loadConfig({ DATABASE_URL: 'postgresql://localhost/solemn' });
const logger = pino({ level: 'silent' });

describe('graceful service shutdown', () => {
  it('starts once, closes once, and prevents restarting', async () => {
    const database = {
      verify: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const worker = createWorker(config, database, logger);
    await Promise.all([worker.start(), worker.start()]);
    await Promise.all([worker.stop(), worker.stop()]);
    expect(database.verify).toHaveBeenCalledTimes(1);
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(worker.execution.getBalanceUsd()).toBe('100');
    await expect(worker.start()).rejects.toThrow('stopped');
  });
  it('waits for in-flight startup before closing the database', async () => {
    let finish: (() => void) | undefined;
    const database = {
      verify: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const worker = createWorker(config, database, logger);
    const starting = worker.start();
    const stopping = worker.stop();
    expect(database.close).not.toHaveBeenCalled();
    finish?.();
    await Promise.all([starting, stopping]);
    expect(database.close).toHaveBeenCalledOnce();
  });
  it('cleans up after startup failure and surfaces close failures', async () => {
    const database = {
      verify: vi.fn().mockRejectedValue(new Error('offline')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const worker = createWorker(config, database, logger);
    await expect(worker.start()).rejects.toThrow('offline');
    await worker.stop();
    expect(database.close).toHaveBeenCalledOnce();
    const failing = createWorker(
      config,
      {
        verify: async () => undefined,
        close: async () => {
          throw new Error('close failed');
        },
      },
      logger,
    );
    await expect(failing.stop()).rejects.toThrow('close failed');
  });
});
