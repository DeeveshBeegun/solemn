import { z } from 'zod';
import { percentageSchema, positiveDecimalSchema } from '@solemn/shared';

const booleanSetting = (fallback: string) =>
  z
    .enum(['true', 'false'])
    .default(fallback as 'true' | 'false')
    .transform((value) => value === 'true');
const integerSetting = (fallback: string, minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));
const pumpPortalUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (
      (local
        ? ['ws:', 'wss:'].includes(url.protocol)
        : url.protocol === 'wss:' &&
          url.hostname === 'pumpportal.fun' &&
          url.pathname === '/api/data') &&
      !url.username &&
      !url.password &&
      !url.hash &&
      [...url.searchParams.keys()].every((key) => key === 'api-key')
    );
  } catch {
    return false;
  }
}, 'Expected the PumpPortal data endpoint or a loopback mock server');

const protocolUrl = (protocols: string[]) =>
  z.url().refine((value) => {
    try {
      return protocols.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Unsupported URL protocol');
export const configSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: protocolUrl(['postgres:', 'postgresql:']),
    SOLANA_RPC_URL: protocolUrl(['http:', 'https:']).default(
      'https://api.mainnet-beta.solana.com',
    ),
    SOLANA_WS_URL: protocolUrl(['ws:', 'wss:']).default(
      'wss://api.mainnet-beta.solana.com',
    ),
    TRADING_MODE: z
      .literal('PAPER', { error: 'Solemn supports PAPER mode only' })
      .default('PAPER'),
    ENABLE_LIVE_TRADING: z
      .literal('false', { error: 'Live trading must remain disabled' })
      .default('false')
      .transform(() => false as const),
    INITIAL_PAPER_BALANCE_USD: positiveDecimalSchema.default('100'),
    PUMPPORTAL_WS_URL: pumpPortalUrl.default('wss://pumpportal.fun/api/data'),
    PUMPPORTAL_API_KEY: z.string().trim().max(4096).default(''),
    SCANNER_ENABLED: booleanSetting('false'),
    SCANNER_SUBSCRIBE_NEW_TOKENS: booleanSetting('true'),
    SCANNER_SUBSCRIBE_MIGRATIONS: booleanSetting('true'),
    SCANNER_RECONNECT_INITIAL_MS: integerSetting('1000', 10, 60000),
    SCANNER_RECONNECT_MAX_MS: integerSetting('30000', 10, 300000),
    SCANNER_RECONNECT_MAX_ATTEMPTS: integerSetting('0', 0, 10000),
    SCANNER_STABLE_CONNECTION_MS: integerSetting('30000', 10, 300000),
    SCANNER_CONNECT_TIMEOUT_MS: integerSetting('10000', 10, 60000),
    SCANNER_HEARTBEAT_INTERVAL_MS: integerSetting('30000', 10, 300000),
    SCANNER_HEARTBEAT_TIMEOUT_MS: integerSetting('10000', 10, 60000),
    SCANNER_QUEUE_CAPACITY: integerSetting('1000', 1, 100000),
    SCANNER_DB_MAX_ATTEMPTS: integerSetting('3', 1, 10),
    SCANNER_DB_RETRY_MS: integerSetting('250', 1, 30000),
    SCANNER_DRAIN_TIMEOUT_MS: integerSetting('20000', 10, 60000),
    SCANNER_METRICS_INTERVAL_MS: integerSetting('30000', 100, 300000),
    SCANNER_MAX_MESSAGE_BYTES: integerSetting('65536', 128, 1048576),
    TOKEN_RISK_ANALYSIS_ENABLED: booleanSetting('false'),
    JUPITER_TOKENS_BASE_URL: protocolUrl(['https:', 'http:']).default(
      'https://api.jup.ag/tokens/v2',
    ),
    JUPITER_API_KEY: z.string().trim().max(4096).default(''),
    JUPITER_REQUEST_INTERVAL_MS: integerSetting('2000', 1, 60000),
    JUPITER_CACHE_TTL_MS: integerSetting('30000', 0, 300000),
    JUPITER_CACHE_MAX_ENTRIES: integerSetting('1000', 1, 10000),
    RISK_MIN_LIQUIDITY_USD: positiveDecimalSchema.default('40000'),
    RISK_MAX_TOP_HOLDERS_PERCENTAGE: percentageSchema.default('35'),
    RISK_MAX_LIQUIDITY_DROP_PERCENTAGE: percentageSchema.default('50'),
    RISK_MAX_DATA_AGE_SECONDS: integerSetting('60', 1, 3600),
    RISK_REQUIRE_HOLDER_DATA: booleanSetting('true'),
    RISK_REQUIRE_EXPLICIT_SUSPICIOUS_FLAG: booleanSetting('true'),
    RISK_POLICY_VERSION: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,100}$/)
      .default('solemn-week3-v1'),
    RISK_ANALYSIS_CONCURRENCY: integerSetting('2', 1, 20),
    RISK_ANALYSIS_RETRY_LIMIT: integerSetting('3', 1, 10),
    RISK_REASSESS_INTERVAL_MS: integerSetting('60000', 10, 3600000),
    RISK_POLL_INTERVAL_MS: integerSetting('1000', 10, 60000),
    RISK_HTTP_TIMEOUT_MS: integerSetting('8000', 10, 60000),
    RISK_HTTP_MAX_ATTEMPTS: integerSetting('3', 1, 5),
    RISK_HTTP_RETRY_MS: integerSetting('1000', 1, 30000),
    RISK_HTTP_MAX_BACKOFF_MS: integerSetting('60000', 1, 300000),
    RISK_RPC_REQUEST_INTERVAL_MS: integerSetting('1000', 1, 60000),
    RISK_JOB_LEASE_MS: integerSetting('300000', 1000, 3600000),
    RISK_SHUTDOWN_TIMEOUT_MS: integerSetting('15000', 10, 120000),
    STRATEGY_ENABLED: booleanSetting('false'),
    STRATEGY_ID: z
      .literal('SOLEMN_LAUNCH_MOMENTUM_V1')
      .default('SOLEMN_LAUNCH_MOMENTUM_V1'),
    STRATEGY_VERSION: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,100}$/)
      .default('1.0.0'),
    MARKET_DATA_PROVIDER: z.literal('FIXTURE').default('FIXTURE'),
    ENABLE_PAID_TRADE_STREAM: z
      .literal('false', {
        error: 'Paid trade streams are not implemented or enabled in Week 4',
      })
      .default('false'),
    MARKET_DATA_MAX_TRACKED_TOKENS: integerSetting('10', 1, 100),
    STRATEGY_FIXTURE_PATH: z.string().max(4096).default(''),
    STRATEGY_POLL_INTERVAL_MS: integerSetting('30000', 100, 300000),
    STRATEGY_MIN_POOL_AGE_MINUTES: integerSetting('2', 0, 90),
    STRATEGY_MAX_POOL_AGE_MINUTES: integerSetting('90', 1, 120),
    STRATEGY_MIN_LIQUIDITY_USD: positiveDecimalSchema.default('40000'),
    STRATEGY_MIN_VOLUME_ACCELERATION: positiveDecimalSchema.default('2.0'),
    STRATEGY_MIN_BUY_SELL_RATIO: positiveDecimalSchema.default('1.5'),
    STRATEGY_MIN_UNIQUE_BUYERS_5M: integerSetting('40', 1, 100000),
    STRATEGY_BREAKOUT_LOOKBACK_CANDLES: integerSetting('3', 1, 15),
    STRATEGY_BREAKOUT_BUFFER_PERCENT: percentageSchema.default('1.0'),
    STRATEGY_MIN_PULLBACK_PERCENT: percentageSchema.default('10.0'),
    STRATEGY_MIN_INITIAL_SPIKE_PERCENT: percentageSchema.default('5.0'),
    STRATEGY_MAX_VOLATILITY_PERCENT: percentageSchema.default('25.0'),
    STRATEGY_PATTERN_MAX_AGE_SECONDS: integerSetting('600', 60, 3600),
    STRATEGY_SIGNAL_COOLDOWN_SECONDS: integerSetting('300', 0, 3600),
    STRATEGY_MAX_RISK_ASSESSMENT_AGE_SECONDS: integerSetting('120', 1, 3600),
    STRATEGY_MAX_MARKET_DATA_AGE_SECONDS: integerSetting('30', 1, 300),
    MARKET_DATA_ALLOWED_LATENESS_MS: integerSetting('5000', 0, 30000),
  })
  .superRefine((config, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (
      config.STRATEGY_MAX_POOL_AGE_MINUTES <
      config.STRATEGY_MIN_POOL_AGE_MINUTES
    )
      issue(
        'STRATEGY_MAX_POOL_AGE_MINUTES',
        'Maximum pool age must not precede minimum pool age',
      );
    if (
      config.MARKET_DATA_ALLOWED_LATENESS_MS >
      config.STRATEGY_MAX_MARKET_DATA_AGE_SECONDS * 1000
    )
      issue(
        'MARKET_DATA_ALLOWED_LATENESS_MS',
        'Lateness must not exceed market-data freshness budget',
      );
    for (const [field, value] of [
      ['JUPITER_TOKENS_BASE_URL', config.JUPITER_TOKENS_BASE_URL],
      ['SOLANA_RPC_URL', config.SOLANA_RPC_URL],
    ] as const) {
      try {
        const url = new URL(value);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(
          url.hostname,
        );
        if (
          config.TOKEN_RISK_ANALYSIS_ENABLED &&
          !local &&
          url.protocol !== 'https:'
        )
          issue(field, 'External risk providers require HTTPS');
        if (
          field === 'JUPITER_TOKENS_BASE_URL' &&
          (url.search || url.hash || url.username || url.password)
        )
          issue(field, 'Use a base URL without credentials, query or fragment');
        if (
          field === 'JUPITER_TOKENS_BASE_URL' &&
          !local &&
          config.JUPITER_REQUEST_INTERVAL_MS <
            (config.JUPITER_API_KEY ? 1000 : 2000)
        )
          issue(
            'JUPITER_REQUEST_INTERVAL_MS',
            'Interval is below the supported keyless/free research budget',
          );
        if (
          field === 'SOLANA_RPC_URL' &&
          !local &&
          config.RISK_RPC_REQUEST_INTERVAL_MS < 1000
        )
          issue(
            'RISK_RPC_REQUEST_INTERVAL_MS',
            'Public RPC research requests must be at least one second apart',
          );
      } catch {
        /* URL validators report their own safe field errors. */
      }
    }
    if (config.JUPITER_CACHE_TTL_MS > config.RISK_MAX_DATA_AGE_SECONDS * 1000)
      issue(
        'JUPITER_CACHE_TTL_MS',
        'Cache TTL must not exceed the maximum data age',
      );
    if (config.SCANNER_RECONNECT_MAX_MS < config.SCANNER_RECONNECT_INITIAL_MS)
      context.addIssue({
        code: 'custom',
        path: ['SCANNER_RECONNECT_MAX_MS'],
        message: 'Must be at least the initial reconnect delay',
      });
    if (
      config.SCANNER_ENABLED &&
      !config.SCANNER_SUBSCRIBE_NEW_TOKENS &&
      !config.SCANNER_SUBSCRIBE_MIGRATIONS
    )
      context.addIssue({
        code: 'custom',
        path: ['SCANNER_ENABLED'],
        message: 'At least one discovery subscription is required',
      });
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): Config {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) {
    // Only field names and fixed validator messages; never include received values.
    throw new Error(
      `Invalid Solemn configuration: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}
