import { describe, expect, it } from 'vitest';
import type { Database } from '@solemn/database';
import { loadConfig } from '../src/config/index.js';
import { checkDatabaseHealth } from '../src/monitoring/databaseHealthMonitor.js';
import { marketHealth } from '../src/monitoring/marketHealthMonitor.js';
import { operatorReason } from '../src/operations/adminControls.js';
import { runtimeState } from '../src/operations/operationalController.js';
import { riskHaltReason } from '../src/operations/runtimeHealth.js';
import { paperConfig, paperEntrySetup } from './paperFixtures.js';

describe('operational state and fail-closed health', () => {
  it('preserves held states through shutdown and restart', () => {
    expect(runtimeState('HALTED', 'RECOVERING')).toBe('HALTED');
    expect(runtimeState('PAUSED', 'STOPPED')).toBe('PAUSED');
    expect(runtimeState('STARTING', 'RECOVERING')).toBe('RECOVERING');
    expect(runtimeState('RECOVERING', 'RUNNING')).toBe('RUNNING');
  });

  const feed = {
    connected: true,
    at: '2026-01-01T00:00:15.000Z',
    lastValidTrade: '2026-01-01T00:00:14.000Z',
    maxAgeSeconds: 15,
    indicatorsReady: true,
    executableQuote: true,
    verified: true,
  };
  it.each([
    [{}, 'HEALTHY'],
    [{ connected: false }, 'DISCONNECTED'],
    [{ lastValidTrade: null }, 'STALE'],
    [{ lastValidTrade: '2026-01-01T00:00:17.000Z' }, 'STALE'],
    [{ verified: false }, 'UNVERIFIED'],
    [{ executableQuote: false }, 'WARMING_UP'],
    [{ indicatorsReady: false }, 'WARMING_UP'],
    [{ queueDepth: 8, queueCapacity: 10 }, 'OVERLOADED'],
  ])('gates market evidence with %j', (changes, expected) => {
    expect(marketHealth({ ...feed, ...changes }).market).toBe(expected);
  });

  it('reports database failures without exposing the driver error', async () => {
    const broken = {
      execute: () => Promise.reject(new Error('credential fixture')),
    } as unknown as Database;
    expect(await checkDatabaseHealth(broken)).toEqual({
      status: 'FAILED',
      queryMs: null,
    });
  });

  it('distinguishes reliable daily loss, drawdown and uncertain execution', async () => {
    const { state } = await paperEntrySetup();
    expect(riskHaltReason(state, true)).toBeNull();
    expect(
      riskHaltReason(
        { ...state, entryBlockReasons: ['DAILY_LOSS_LIMIT'] },
        true,
      ),
    ).toBe('DAILY_LOSS_LIMIT');
    expect(
      riskHaltReason(
        { ...state, entryBlockReasons: ['DAILY_LOSS_LIMIT'] },
        false,
      ),
    ).toBeNull();
    expect(
      riskHaltReason(
        { ...state, status: 'HALTED', haltReason: 'TOTAL_DRAWDOWN_LIMIT' },
        true,
      ),
    ).toBe('TOTAL_DRAWDOWN_LIMIT');
    expect(riskHaltReason({ ...state, executionUncertain: true }, false)).toBe(
      'PAPER_EXECUTION_UNCERTAIN',
    );
  });
});

describe('operational security', () => {
  it.each([
    { TRADING_MODE: 'LIVE' },
    { ENABLE_LIVE_TRADING: 'true' },
    { ENABLE_SIGNING: 'true' },
    { JUPITER_EXECUTE_URL: 'https://example.invalid' },
    { WALLET_PRIVATE_KEY: 'secret-fixture' },
    { ENABLE_TRANSACTION_BROADCAST: 'maybe' },
    { EXECUTION_ADAPTER: 'LIVE' },
  ])('rejects unsafe configuration', (change) => {
    expect(() =>
      loadConfig({ DATABASE_URL: paperConfig.DATABASE_URL, ...change }),
    ).toThrow();
  });
  it('requires safe nonsecret text for an emergency reason', () => {
    expect(() => operatorReason(undefined, paperConfig)).toThrow('explicit');
    expect(() => operatorReason('Authorization: token', paperConfig)).toThrow(
      'plain text',
    );
    expect(() => operatorReason('password', paperConfig)).toThrow('protected');
    expect(operatorReason('Incident 11 - exercise', paperConfig)).toBe(
      'Incident 11 - exercise',
    );
  });
});
