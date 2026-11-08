import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createScannerService } from '../src/scanner/scannerService.js';
import type { TransportHandlers } from '../src/scanner/pumpPortalClient.js';
import { loadConfig } from '../src/config/index.js';
import { creationAck, launchRaw, migrationAck } from './scannerFixtures.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://localhost/solemn',
  SCANNER_ENABLED: 'true',
  SCANNER_RECONNECT_INITIAL_MS: '30000',
  SCANNER_RECONNECT_MAX_MS: '30000',
});
describe('scanner processing composition', () => {
  it('opens no transport or database writes when disabled', async () => {
    const factory = vi.fn();
    const repository = { persistEvent: vi.fn(), recordGap: vi.fn() };
    const scanner = createScannerService(
      { ...config, SCANNER_ENABLED: false },
      repository,
      pino({ level: 'silent' }),
      factory,
    );
    await scanner.start();
    await scanner.stop();
    expect(factory).not.toHaveBeenCalled();
    expect(repository.recordGap).not.toHaveBeenCalled();
  });
  it('processes messages and duplicates and sanitizes rejected payload logging', async () => {
    const repository = {
      persistEvent: vi
        .fn()
        .mockResolvedValueOnce('INSERTED')
        .mockResolvedValueOnce('DUPLICATE'),
      recordGap: vi.fn().mockResolvedValue(undefined),
    };
    let handlers: TransportHandlers | undefined;
    let logs = '';
    const logger = pino(
      {},
      {
        write: (value) => {
          logs += value;
        },
      },
    );
    const scanner = createScannerService(
      config,
      repository,
      logger,
      (_url, callbacks) => {
        handlers = callbacks;
        return {
          send: vi.fn(),
          ping: vi.fn(),
          close: () => callbacks.close(1000),
          terminate: () => callbacks.close(1006),
        };
      },
    );
    await scanner.start();
    handlers?.open();
    handlers?.message(creationAck, false);
    handlers?.message(migrationAck, false);
    handlers?.message(launchRaw, false);
    handlers?.message(launchRaw, false);
    handlers?.message('{"message":"unknown SECRET"}', false);
    handlers?.message('{not json SECRET', false);
    handlers?.message('binary SECRET', true);
    await scanner.waitForIdle();
    expect(scanner.metrics()).toMatchObject({
      successfulWrites: 1,
      duplicateEvents: 1,
      rejectedMessages: 2,
      queueDepth: 0,
    });
    expect(logs).not.toContain('SECRET');
    await scanner.stop();
    expect(repository.recordGap).toHaveBeenCalledTimes(3);
  });
  it('disconnects on saturation, records a gap, and drains accepted work', async () => {
    let handlers: TransportHandlers | undefined;
    let release: (() => void) | undefined;
    const repository = {
      persistEvent: vi.fn(
        () =>
          new Promise<'INSERTED'>((resolve) => {
            release = () => resolve('INSERTED');
          }),
      ),
      recordGap: vi.fn().mockResolvedValue(undefined),
    };
    const terminate = vi.fn(() => handlers?.close(1006));
    const scanner = createScannerService(
      { ...config, SCANNER_QUEUE_CAPACITY: 1 },
      repository,
      pino({ level: 'silent' }),
      (_url, callbacks) => {
        handlers = callbacks;
        return {
          send: vi.fn(),
          ping: vi.fn(),
          close: () => callbacks.close(1000),
          terminate,
        };
      },
    );
    await scanner.start();
    handlers?.open();
    handlers?.message(creationAck, false);
    handlers?.message(migrationAck, false);
    await scanner.waitForIdle();
    handlers?.message(launchRaw, false);
    handlers?.message(launchRaw, false);
    expect(terminate).toHaveBeenCalledOnce();
    expect(scanner.metrics().droppedEvents).toBe(1);
    const stopped = scanner.stop();
    release?.();
    await stopped;
    expect(repository.persistEvent).toHaveBeenCalledOnce();
    expect(
      repository.recordGap.mock.calls.some(
        ([gap]) => gap.reason === 'QUEUE_SATURATED',
      ),
    ).toBe(true);
  });
});
