import type { Config } from '../config/index.js';

export function assertPaperMode(
  config: Pick<Config, 'TRADING_MODE' | 'ENABLE_LIVE_TRADING'>,
) {
  if (config.TRADING_MODE !== 'PAPER' || config.ENABLE_LIVE_TRADING !== false)
    throw new Error('Solemn requires the compiled-in paper execution path');
}

const signingVariables = new Set([
  'SOLANA_PRIVATE_KEY',
  'WALLET_PRIVATE_KEY',
  'BS58_PRIVATE_KEY',
  'SIGNING_KEY',
  'SIGNER_URL',
  'WALLET_KEYPAIR_PATH',
  'SOLANA_KEYPAIR_PATH',
  'JUPITER_EXECUTE_URL',
  'SOLANA_BROADCAST_URL',
]);
const executionFlags = new Set([
  'ENABLE_SIGNING',
  'ENABLE_PRIVATE_KEY_LOADING',
  'ENABLE_TRANSACTION_SIGNING',
  'ENABLE_TRANSACTION_BROADCAST',
  'ENABLE_LIVE_SWAPS',
  'JUPITER_EXECUTE_ENABLED',
  'SOLANA_SEND_TRANSACTION_ENABLED',
  'SOLANA_SEND_RAW_TRANSACTION_ENABLED',
]);
export function assertNoExecutionCapabilities(
  environment: Record<string, string | undefined>,
) {
  if (
    environment.EXECUTION_ADAPTER !== undefined &&
    environment.EXECUTION_ADAPTER !== 'PAPER'
  )
    throw new Error('Unsupported execution adapter');
  for (const key of signingVariables)
    if (environment[key]?.trim())
      throw new Error('Unsupported signing or broadcast configuration');
  for (const key of executionFlags) {
    const value = environment[key];
    if (value !== undefined && value !== 'false')
      throw new Error('Unsupported signing or broadcast configuration');
  }
}
