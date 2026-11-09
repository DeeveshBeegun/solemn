import {
  CandidateManager,
  marketKey,
} from '../src/forward/candidateManager.js';
import { createReplayProvider } from '../src/forward/replayProvider.js';
import { createStressFixture } from '../src/backtesting/stressScenarios.js';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { runForwardCommand } from '../src/forward/forwardTradingService.js';
import {
  admitMeteredMessage,
  inspectTradeMessage,
  newBudget,
} from '../src/forward/meteredFeed.js';
import { PumpPortalClient } from '../src/scanner/pumpPortalClient.js';
import type { TransportHandlers } from '../src/scanner/pumpPortalClient.js';
import { MINT, OTHER_MINT } from './scannerFixtures.js';

const env = { DATABASE_URL: 'postgresql://localhost/solemn' };
const logger = pino({ level: 'silent' });
it('defaults to disabled replay and requires both explicit live metering opt-ins and an API key', async () => {
  const config = loadConfig(env);
  expect(config).toMatchObject({
    FORWARD_PAPER_ENABLED: false,
    FORWARD_MARKET_DATA_MODE: 'REPLAY',
    ENABLE_METERED_MARKET_DATA: false,
    ENABLE_LIVE_TRADING: false,
  });
  await expect(runForwardCommand(config, logger)).rejects.toThrow(
    'FORWARD_PAPER_ENABLED',
  );
  expect(() =>
    loadConfig({
      ...env,
      FORWARD_PAPER_ENABLED: 'true',
      ENABLE_METERED_MARKET_DATA: 'true',
    }),
  ).toThrow('Metered data requires');
  expect(() =>
    loadConfig({
      ...env,
      FORWARD_PAPER_ENABLED: 'true',
      SCANNER_ENABLED: 'true',
    }),
  ).toThrow('Forward owns');
  expect(() =>
    loadConfig({
      ...env,
      FORWARD_PAPER_ENABLED: 'true',
      FORWARD_MARKET_DATA_MODE: 'LIVE_READ_ONLY',
      ENABLE_METERED_MARKET_DATA: 'true',
    }),
  ).toThrow('PUMPPORTAL_API_KEY');
});

it('tracks metered receipts including duplicates and keeps the budget latched across UTC days', () => {
  const at = '2026-01-01T00:00:00.000Z',
    budget = newBudget(at);
  budget.armed = true;
  expect(admitMeteredMessage(budget, at, 2)).toBe(true);
  expect(admitMeteredMessage(budget, at, 2)).toBe(true);
  expect(budget).toMatchObject({ events: 2, blocked: true });
  const recovered = structuredClone(budget);
  expect(admitMeteredMessage(recovered, '2026-01-02T00:00:00.000Z', 2)).toBe(
    false,
  );
  expect(recovered.events).toBe(2);
});

it('keeps exact provider amounts and leaves absent chain time and execution evidence unknown', () => {
  const raw = `{"txType":"buy","mint":"${MINT}","tokenAmount":9007199254740993,"solAmount":0.002,"api-key":"mock-secret"}`;
  const trade = inspectTradeMessage(raw, '2026-01-01T00:00:00.000Z', 2000)!;
  expect(trade.evidence).toMatchObject({
    tokenAmount: '9007199254740993',
    solAmount: '0.002',
    sourceAt: null,
    executionReadiness: 'NOT_READY',
  });
  expect(JSON.stringify(trade)).not.toContain('mock-secret');
  expect(
    inspectTradeMessage(
      '{"txType":"create"}',
      '2026-01-01T00:00:00.000Z',
      2000,
    ),
  ).toBeNull();
});

it('sends bounded subscribe and unsubscribe deltas on the discovery socket and halts at budget exhaustion', async () => {
  const config = loadConfig({
    ...env,
    FORWARD_PAPER_ENABLED: 'true',
    FORWARD_MARKET_DATA_MODE: 'LIVE_READ_ONLY',
    ENABLE_METERED_MARKET_DATA: 'true',
    PUMPPORTAL_API_KEY: 'mock-test-key',
    FORWARD_MAX_TRACKED_TOKENS: '1',
  });
  let handlers: TransportHandlers | undefined;
  const sent: string[] = [];
  const gaps = vi.fn();
  const factory = vi.fn((_url: string, callbacks: TransportHandlers) => {
    handlers = callbacks;
    return {
      send: (s: string) => sent.push(s),
      ping: vi.fn(),
      close: () => callbacks.close(1000),
      terminate: () => callbacks.close(1006),
    };
  });
  const client = new PumpPortalClient(
    config,
    logger,
    {
      message: vi.fn(),
      gap: gaps,
      reconnect: vi.fn(),
      canReconnect: () => true,
    },
    factory,
  );
  try {
    client.start();
    client.watchTrades([MINT]);
    handlers?.open();
    expect(sent.map((s) => JSON.parse(s).method)).toEqual([
      'subscribeNewToken',
      'subscribeMigration',
    ]);
    client.acknowledge('subscribeNewToken');
    client.acknowledge('subscribeMigration');
    expect(JSON.parse(sent.at(-1)!)).toEqual({
      method: 'subscribeTokenTrade',
      keys: [MINT],
    });
    expect(() => client.watchTrades([MINT, OTHER_MINT])).toThrow('capacity');
    client.watchTrades([OTHER_MINT]);
    expect(sent.slice(-2).map((s) => JSON.parse(s))).toEqual([
      { method: 'unsubscribeTokenTrade', keys: [MINT] },
      { method: 'subscribeTokenTrade', keys: [OTHER_MINT] },
    ]);
    client.disconnect('METERED_BUDGET_EXHAUSTED', true);
    client.watchTrades([MINT]);
    expect(client.status).toBe('HALTED');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(gaps).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'METERED_BUDGET_EXHAUSTED' }),
    );
  } finally {
    await client.stop();
  }
});

it('keeps a held token ahead of an eligible candidate and never claims coverage before admission', async () => {
  const config = { ...loadConfig(env), FORWARD_MAX_TRACKED_TOKENS: 1 };
  const tape = createReplayProvider(config, createStressFixture(config)),
    watch = new CandidateManager(tape.markets, config);
  const held = tape.markets[1]!;
  for await (const frame of tape.frames()) {
    watch.ingest(frame, [
      { mint: held.mint, poolAddress: held.poolAddress, status: 'OPEN' },
    ]);
    expect([...watch.monitored.keys()]).toEqual([
      marketKey(held.mint, held.poolAddress),
    ]);
    if (frame.candleEnd) break;
  }
  const single = createReplayProvider(config),
    candidate = new CandidateManager(single.markets, config);
  for await (const frame of single.frames()) {
    candidate.ingest(frame, []);
    if (frame.candleEnd && candidate.monitored.size) {
      const market = [...candidate.monitored.values()][0]!;
      expect(
        candidate.finalize(market, frame.candleEnd, frame.at),
      ).toMatchObject({ complete: false, volumeUsd: null });
      return;
    }
  }
  throw new Error('Fixture did not admit a candidate');
});
