import type { Config } from '../../config/index.js';
import { signed } from '../../portfolio/decimal.js';
import type { SwapQuote } from './jupiterClient.js';

export type ReadinessStatus =
  | 'READY_FOR_DRY_RUN'
  | 'REJECTED'
  | 'INSUFFICIENT_DATA'
  | 'UNSUPPORTED'
  | 'EXPIRED';
export type Decision = { status: ReadinessStatus; reason: string };
export const ready: Decision = {
  status: 'READY_FOR_DRY_RUN',
  reason: 'QUOTE_CHECKS_PASSED',
};

export function quoteFreshness(
  quote: SwapQuote,
  now: number,
  maxAgeMs: number,
  blockHeight?: bigint | null,
): Decision {
  if (quote.expireAt && now >= Date.parse(quote.expireAt))
    return { status: 'EXPIRED', reason: 'RFQ_EXPIRED' };
  const age = now - Date.parse(quote.quotedAt);
  if (
    age < 0 ||
    age >= maxAgeMs ||
    now - Date.parse(quote.requestedAt) >= maxAgeMs
  )
    return { status: 'EXPIRED', reason: 'QUOTE_AGE_EXCEEDED' };
  if (quote.lastValidBlockHeight != null) {
    if (blockHeight == null)
      return { status: 'INSUFFICIENT_DATA', reason: 'BLOCK_HEIGHT_UNVERIFIED' };
    if (blockHeight > BigInt(quote.lastValidBlockHeight))
      return { status: 'EXPIRED', reason: 'BLOCK_HEIGHT_EXCEEDED' };
  }
  return ready;
}

export function validateQuote(
  quote: SwapQuote,
  config: Config,
  requestedSlippage?: number,
): Decision {
  const minimum = BigInt(quote.otherAmountThreshold),
    output = BigInt(quote.outAmount);
  if (
    quote.slippageBps >
      Math.min(config.JUPITER_MAX_SLIPPAGE_BPS, requestedSlippage ?? 10000) ||
    minimum === 0n ||
    minimum > output ||
    minimum < (output * BigInt(10000 - quote.slippageBps)) / 10000n
  )
    return { status: 'REJECTED', reason: 'SLIPPAGE_PROTECTION_INVALID' };
  if (quote.feeBps != null && quote.feeBps > config.JUPITER_MAX_FEE_BPS)
    return { status: 'REJECTED', reason: 'FEE_BPS_EXCEEDED' };
  if (
    quote.priceImpact != null &&
    signed(quote.priceImpact) <
      -BigInt(config.JUPITER_MAX_PRICE_IMPACT_BPS) * 10n ** 16n
  )
    return { status: 'REJECTED', reason: 'PRICE_IMPACT_EXCEEDED' };
  if (quote.feeBps == null || quote.priceImpact == null)
    return {
      status: 'INSUFFICIENT_DATA',
      reason: 'QUOTE_COST_EVIDENCE_MISSING',
    };
  if (
    (quote.feeBps > 0 && !quote.feeMint) ||
    [quote.feeMint, quote.platformFee?.feeMint].some(
      (mint) =>
        mint != null && mint !== quote.inputMint && mint !== quote.outputMint,
    )
  )
    return { status: 'INSUFFICIENT_DATA', reason: 'FEE_MINT_UNPRICED' };
  if (
    (quote.platformFee?.feeBps ?? 0) > quote.feeBps ||
    (quote.platformFee?.feeMint &&
      quote.feeMint &&
      quote.platformFee.feeMint !== quote.feeMint)
  )
    return { status: 'REJECTED', reason: 'FEE_BREAKDOWN_INCONSISTENT' };
  if (quote.transactionStatus === 'BUILD_UNAVAILABLE')
    return { status: 'REJECTED', reason: 'UNSIGNED_BUILD_UNAVAILABLE' };
  return ready;
}
