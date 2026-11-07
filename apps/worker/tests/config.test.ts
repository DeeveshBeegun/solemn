import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { safeError } from '../src/services/logger.js';

const environment = {
  DATABASE_URL: 'postgresql://solemn:private_password@localhost:5432/solemn',
};

describe('configuration', () => {
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
