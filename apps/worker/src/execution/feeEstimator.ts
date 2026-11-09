import { fromAtomic, toAtomic } from '@solemn/shared';
import { ceilDivide } from '../portfolio/decimal.js';
import { wrappedSol } from './jupiter/amounts.js';
import type { SwapQuote } from './jupiter/jupiterClient.js';

/** Provider fee rates overlap. Never add platformFee to feeBps or subtract either from outAmount. */
export function estimateSwapFees(quote: SwapQuote, nativeUsd: string | null) {
  const fees = [
    {
      category: 'SIGNATURE',
      lamports: quote.signatureFeeLamports ?? null,
      payer: quote.signatureFeePayer ?? null,
    },
    {
      category: 'PRIORITY_AND_TIPS',
      lamports: quote.prioritizationFeeLamports ?? null,
      payer: quote.prioritizationFeePayer ?? null,
    },
    {
      category: 'RENT_DEPOSIT',
      lamports: quote.rentFeeLamports ?? null,
      payer: quote.rentFeePayer ?? null,
    },
  ].map((fee) => ({
    ...fee,
    mint: wrappedSol,
    treatment:
      fee.category === 'RENT_DEPOSIT'
        ? 'POTENTIALLY_RECOVERABLE'
        : 'TRANSACTION_ESTIMATE',
    takerPays:
      fee.lamports === '0'
        ? false
        : quote.taker && fee.payer
          ? fee.payer === quote.taker
          : null,
    usd:
      fee.lamports === '0'
        ? '0'
        : fee.lamports && nativeUsd
          ? fromAtomic(
              ceilDivide(
                BigInt(fee.lamports) * toAtomic(nativeUsd),
                1000000000n,
              ),
            )
          : null,
  }));
  const feesPriced = fees.every((fee) => fee.usd !== null);
  return {
    embedded: {
      totalProviderFeeBps: quote.feeBps ?? null,
      feeMint: quote.feeMint ?? null,
      platform: quote.platformFee ?? null,
      poolAndTransferBreakdown: 'UNKNOWN',
    },
    fees,
    estimatedSolDebitsUpperBoundUsd: feesPriced
      ? fromAtomic(fees.reduce((total, fee) => total + toAtomic(fee.usd!), 0n))
      : null,
    feesPriced,
    totalCostComplete: false,
    limitations: [
      'POOL_AND_TRANSFER_FEES_NOT_ITEMIZED',
      ...(quote.taker ? [] : ['QUOTE_ONLY_WALLET_COSTS_UNCONFIRMED']),
    ],
  };
}
