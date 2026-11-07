import { z } from 'zod';
import { positiveDecimalSchema } from '@solemn/shared';

const protocolUrl = (protocols: string[]) =>
  z.url().refine((value) => {
    try {
      return protocols.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Unsupported URL protocol');
export const configSchema = z.object({
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
    .literal('PAPER', { error: 'Week 1 supports PAPER mode only' })
    .default('PAPER'),
  ENABLE_LIVE_TRADING: z
    .literal('false', { error: 'Live trading must remain disabled in Week 1' })
    .default('false')
    .transform(() => false as const),
  INITIAL_PAPER_BALANCE_USD: positiveDecimalSchema.default('100'),
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
