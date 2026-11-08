import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScannerGap } from '@solemn/shared';
import { loadConfig } from '../src/config/index.js';
import { PumpPortalClient } from '../src/scanner/pumpPortalClient.js';
import type {
  ScannerTransport,
  TransportHandlers,
} from '../src/scanner/pumpPortalClient.js';

export class FakeTransport implements ScannerTransport {
  readonly sent: string[] = [];
  constructor(readonly handlers: TransportHandlers) {}
  send(value: string) {
    this.sent.push(value);
  }
  ping = vi.fn();
  close = vi.fn(() => this.handlers.close(1000));
  terminate = vi.fn(() => this.handlers.close(1006));
}

const environment = {
  DATABASE_URL: 'postgresql://localhost/solemn',
  SCANNER_ENABLED: 'true',
  SCANNER_HEARTBEAT_INTERVAL_MS: '60000',
};
describe('PumpPortal transport lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  function setup(extra: Record<string, string> = {}) {
    const sockets: FakeTransport[] = [];
    const gaps: ScannerGap[] = [];
    let logs = '';
    const logger = pino(
      { level: 'trace' },
      {
        write: (chunk) => {
          logs += chunk;
        },
      },
    );
    const reconnect = vi.fn();
    const canReconnect = vi.fn(() => true);
    const client = new PumpPortalClient(
      loadConfig({ ...environment, ...extra }),
      logger,
      {
        message: vi.fn(),
        gap: (gap) => gaps.push(gap),
        reconnect,
        canReconnect,
      },
      (_url, handlers) => {
        const socket = new FakeTransport(handlers);
        sockets.push(socket);
        return socket;
      },
      () => 0.5,
    );
    return { client, sockets, gaps, reconnect, canReconnect, logs: () => logs };
  }
  it('uses one connection, sends only free methods, acknowledges subscriptions and stops idempotently', async () => {
    const { client, sockets, gaps } = setup();
    client.start();
    client.start();
    expect(sockets).toHaveLength(1);
    sockets[0]?.handlers.open();
    expect(sockets[0]?.sent.map((raw) => JSON.parse(raw).method)).toEqual([
      'subscribeNewToken',
      'subscribeMigration',
    ]);
    client.acknowledge('subscribeNewToken');
    client.acknowledge('subscribeMigration');
    expect(gaps).toHaveLength(2);
    expect(gaps[1]?.endedAt).not.toBeNull();
    await Promise.all([client.stop(), client.stop()]);
    expect(sockets[0]?.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120000);
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe('DISCONNECTED');
  });
  it('reconnects exponentially, restores subscriptions, and resets after stability', async () => {
    const { client, sockets, reconnect } = setup();
    client.start();
    sockets[0]?.handlers.open();
    sockets[0]?.handlers.error();
    await vi.advanceTimersByTimeAsync(749);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1]?.handlers.open();
    expect(sockets[1]?.sent).toEqual(sockets[0]?.sent);
    sockets[1]?.handlers.close(1006);
    await vi.advanceTimersByTimeAsync(1499);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    sockets[2]?.handlers.open();
    client.acknowledge('subscribeNewToken');
    client.acknowledge('subscribeMigration');
    await vi.advanceTimersByTimeAsync(30000);
    sockets[2]?.handlers.close(1006);
    await vi.advanceTimersByTimeAsync(750);
    expect(sockets).toHaveLength(4);
    expect(reconnect).toHaveBeenCalledTimes(3);
    await client.stop();
  });
  it('waits for queue recovery without opening simultaneous connections', async () => {
    const { client, sockets, canReconnect } = setup();
    client.start();
    sockets[0]?.handlers.open();
    canReconnect.mockReturnValue(false);
    client.disconnect('QUEUE_SATURATED');
    await vi.advanceTimersByTimeAsync(3000);
    expect(sockets).toHaveLength(1);
    canReconnect.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(sockets).toHaveLength(2);
    await client.stop();
  });
  it('caps exponential reconnect delay', async () => {
    const { client, sockets } = setup({ SCANNER_RECONNECT_MAX_MS: '1000' });
    client.start();
    sockets[0]?.handlers.error();
    await vi.advanceTimersByTimeAsync(750);
    expect(sockets).toHaveLength(2);
    sockets[1]?.handlers.error();
    await vi.advanceTimersByTimeAsync(750);
    expect(sockets).toHaveLength(3);
    await client.stop();
  });
  it('halts on authentication failures without exposing credentials', async () => {
    const { client, sockets, logs } = setup({
      PUMPPORTAL_API_KEY: 'SECRET_API_KEY',
      PUMPPORTAL_WS_URL: 'wss://pumpportal.fun/api/data?api-key=URL_SECRET',
    });
    client.start();
    sockets[0]?.handlers.response(401);
    await vi.advanceTimersByTimeAsync(60000);
    expect(client.status).toBe('HALTED');
    expect(sockets).toHaveLength(1);
    expect(logs()).not.toContain('SECRET_API_KEY');
    expect(logs()).not.toContain('URL_SECRET');
    await client.stop();
  });
  it('detects missing heartbeats and observes pong replies', async () => {
    const { client, sockets, gaps } = setup({
      SCANNER_HEARTBEAT_INTERVAL_MS: '100',
      SCANNER_HEARTBEAT_TIMEOUT_MS: '50',
    });
    client.start();
    sockets[0]?.handlers.open();
    client.acknowledge('subscribeNewToken');
    client.acknowledge('subscribeMigration');
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets[0]?.ping).toHaveBeenCalledOnce();
    sockets[0]?.handlers.pong();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets[0]?.ping).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets[0]?.terminate).toHaveBeenCalledOnce();
    expect(gaps.at(-1)?.reason).toBe('HEARTBEAT_TIMEOUT');
    await client.stop();
  });
  it('times out unacknowledged subscriptions', async () => {
    const { client, sockets } = setup({ SCANNER_CONNECT_TIMEOUT_MS: '100' });
    client.start();
    sockets[0]?.handlers.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets[0]?.terminate).toHaveBeenCalledOnce();
    await client.stop();
  });
  it('caps retries and handles connection constructor errors', async () => {
    const { client, sockets } = setup({ SCANNER_RECONNECT_MAX_ATTEMPTS: '1' });
    client.start();
    sockets[0]?.handlers.error();
    await vi.advanceTimersByTimeAsync(750);
    sockets[1]?.handlers.error();
    expect(client.status).toBe('HALTED');
    await client.stop();
    const failing = new PumpPortalClient(
      loadConfig(environment),
      pino({ level: 'silent' }),
      {
        message: vi.fn(),
        gap: vi.fn(),
        reconnect: vi.fn(),
        canReconnect: () => true,
      },
      () => {
        throw new Error('secret credential error');
      },
    );
    expect(() => failing.start()).not.toThrow();
    expect(failing.status).toBe('RECONNECTING');
    await failing.stop();
  });
});
