import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { safeError } from '../src/services/logger.js';

const environment = {
  DATABASE_URL: 'postgresql://solemn:private_password@localhost:5432/solemn',
};

describe('configuration', () => {
  it('defaults risk networking off, protects rate budgets, and validates research amounts', () => {
    expect(loadConfig(environment).TOKEN_RISK_ANALYSIS_ENABLED).toBe(false);
    expect(() =>
      loadConfig({ ...environment, JUPITER_REQUEST_INTERVAL_MS: '10' }),
    ).toThrow('JUPITER_REQUEST_INTERVAL_MS');
    expect(() =>
      loadConfig({ ...environment, RISK_MAX_TOP_HOLDERS_PERCENTAGE: '101' }),
    ).toThrow('RISK_MAX_TOP_HOLDERS_PERCENTAGE');
    expect(() =>
      loadConfig({ ...environment, RISK_MIN_LIQUIDITY_USD: '1e4' }),
    ).toThrow('RISK_MIN_LIQUIDITY_USD');
    expect(() =>
      loadConfig({ ...environment, JUPITER_CACHE_TTL_MS: '61000' }),
    ).toThrow('JUPITER_CACHE_TTL_MS');
  });
  it('defaults to offline discovery and validates scanner settings', () => {
    expect(loadConfig(environment).SCANNER_ENABLED).toBe(false);
    expect(() =>
      loadConfig({ ...environment, SCANNER_QUEUE_CAPACITY: '-1' }),
    ).toThrow('SCANNER_QUEUE_CAPACITY');
    expect(() =>
      loadConfig({ ...environment, SCANNER_ENABLED: 'yes' }),
    ).toThrow('SCANNER_ENABLED');
    expect(() =>
      loadConfig({ ...environment, SCANNER_RECONNECT_MAX_MS: '10' }),
    ).toThrow('SCANNER_RECONNECT_MAX_MS');
    expect(() =>
      loadConfig({
        ...environment,
        SCANNER_ENABLED: 'true',
        SCANNER_SUBSCRIBE_NEW_TOKENS: 'false',
        SCANNER_SUBSCRIBE_MIGRATIONS: 'false',
      }),
    ).toThrow('SCANNER_ENABLED');
    expect(() =>
      loadConfig({
        ...environment,
        PUMPPORTAL_WS_URL: 'wss://pumpportal.fun/api/trade?api-key=SECRET',
      }),
    ).toThrow('PUMPPORTAL_WS_URL');
  });
  it('defaults to PAPER and $100 without wallet credentials', () => {
    const config = loadConfig(environment);
    expect(config.TRADING_MODE).toBe('PAPER');
    expect(config.ENABLE_LIVE_TRADING).toBe(false);
    expect(config.INITIAL_PAPER_BALANCE_USD).toBe('100');
  });
  it.each(['LIVE', 'live', '', 'PAPER '])('rejects trading mode %s', (mode) => {
    expect(() => loadConfig({ ...environment, TRADING_MODE: mode })).toThrow(
      'PAPER mode only',
    );
  });
  it.each(['true', '1', 'FALSE', ''])('rejects live enable flag %s', (flag) => {
    expect(() =>
      loadConfig({ ...environment, ENABLE_LIVE_TRADING: flag }),
    ).toThrow('Live trading must remain disabled');
  });
  it('reports useful field errors without secret values', () => {
    expect(() =>
      loadConfig({ ...environment, LOG_LEVEL: 'secret-log-level' }),
    ).toThrow('LOG_LEVEL');
    try {
      loadConfig({
        DATABASE_URL: 'https://solemn:super_secret@localhost/solemn',
      });
    } catch (error) {
      expect(String(error)).toContain('DATABASE_URL');
      expect(String(error)).not.toContain('super_secret');
    }
    expect(() => loadConfig({})).toThrow('DATABASE_URL');
    expect(() =>
      loadConfig({ ...environment, SOLANA_WS_URL: 'https://example.com' }),
    ).toThrow('SOLANA_WS_URL');
    expect(() =>
      loadConfig({ ...environment, DATABASE_URL: 'invalid' }),
    ).toThrow('DATABASE_URL');
  });
  it.each(['-1', '1e2', 'NaN', '0'])(
    'rejects invalid initial balance %s',
    (balance) => {
      expect(() =>
        loadConfig({ ...environment, INITIAL_PAPER_BALANCE_USD: balance }),
      ).toThrow('INITIAL_PAPER_BALANCE_USD');
    },
  );
  it('sanitizes unexpected driver errors', () => {
    const error = Object.assign(new Error(environment.DATABASE_URL), {
      code: 'ECONNREFUSED',
    });
    expect(safeError(error)).toEqual({
      errorType: 'Error',
      code: 'ECONNREFUSED',
    });
    expect(JSON.stringify(safeError(error))).not.toContain('private_password');
  });
});
