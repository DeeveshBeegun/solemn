import pino from 'pino';
import type { Config } from '../config/index.js';

export function createLogger(level: Config['LOG_LEVEL']) {
  return pino({
    name: 'solemn-worker',
    level,
    redact: {
      paths: [
        'DATABASE_URL',
        'databaseUrl',
        'password',
        'secret',
        'privateKey',
        '*.password',
        '*.DATABASE_URL',
        '*.databaseUrl',
        '*.secret',
        '*.privateKey',
        'PUMPPORTAL_API_KEY',
        'PUMPPORTAL_WS_URL',
        '*.PUMPPORTAL_API_KEY',
        '*.PUMPPORTAL_WS_URL',
        'apiKey',
        '*.apiKey',
        'JUPITER_API_KEY',
        '*.JUPITER_API_KEY',
        'SOLANA_RPC_URL',
        '*.SOLANA_RPC_URL',
        'headers',
        '*.headers',
      ],
      censor: '[REDACTED]',
    },
  });
}

/** Drivers may embed credentials, connection strings or SQL parameters in errors. */
export function safeError(error: unknown): {
  errorType: string;
  code?: string;
} {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  return {
    errorType: error instanceof Error ? 'Error' : 'UnknownError',
    ...(typeof code === 'string' && /^[A-Z0-9_]{2,24}$/.test(code)
      ? { code }
      : {}),
  };
}
