import { fromAtomic, mintAddressSchema } from '@solemn/shared';
import { z } from 'zod';

const maxU64 = (1n << 64n) - 1n;
export const unitsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((value) => /^[0-9]{1,20}$/.test(value) && BigInt(value) <= maxU64);
export const positiveUnits = unitsSchema.refine((value) => value !== '0');
export const decimalsSchema = z.number().int().min(0).max(255);
export const wrappedSol = 'So11111111111111111111111111111111111111112';
export const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const routerSchema = z.enum(['metis', 'jupiterz', 'dflow', 'okx']);
export const swapRequestSchema = z
  .strictObject({
    inputMint: mintAddressSchema,
    outputMint: mintAddressSchema,
    amount: positiveUnits,
    inputDecimals: decimalsSchema,
    outputDecimals: decimalsSchema,
    slippageBps: z.number().int().min(0).max(9999).optional(),
    excludeRouters: z.array(routerSchema).max(3).default([]),
  })
  .superRefine((request, context) => {
    if (request.inputMint === request.outputMint)
      context.addIssue({
        code: 'custom',
        path: ['outputMint'],
        message: 'Swap mints must differ',
      });
    for (const side of ['input', 'output'] as const) {
      const mint = request[side === 'input' ? 'inputMint' : 'outputMint'];
      const key = side === 'input' ? 'inputDecimals' : 'outputDecimals';
      if (
        (mint === wrappedSol && request[key] !== 9) ||
        (mint === usdc && request[key] !== 6)
      )
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Incorrect decimals for known mint',
        });
    }
  })
  .transform(({ slippageBps, ...request }) => ({
    ...request,
    ...(slippageBps === undefined ? {} : { slippageBps }),
    excludeRouters: [...new Set(request.excludeRouters)].sort(),
  }));
export type SwapRequest = z.infer<typeof swapRequestSchema>;

/** Reject unrepresentable precision instead of rounding the spend upward. */
export function toBaseUnits(amount: string, decimals: number): string {
  decimalsSchema.parse(decimals);
  if (!/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,255})?$/.test(amount))
    throw new Error('Invalid decimal amount');
  const [whole = '', fraction = ''] = amount.split('.');
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > decimals)
    throw new Error('Amount is below the mint precision');
  return positiveUnits.parse(
    BigInt(whole + significant.padEnd(decimals, '0')).toString(),
  );
}

export function fromBaseUnits(amount: string, decimals: number): string {
  const value = unitsSchema
    .parse(amount)
    .padStart(decimalsSchema.parse(decimals) + 1, '0');
  if (!decimals) return value;
  const fraction = value.slice(-decimals).replace(/0+$/, '');
  return value.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}

export function effectiveRate(request: SwapRequest, output: string) {
  const numerator = BigInt(output) * 10n ** BigInt(request.inputDecimals);
  const denominator =
    BigInt(request.amount) * 10n ** BigInt(request.outputDecimals);
  return {
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    decimalTruncated18: fromAtomic((numerator * 10n ** 18n) / denominator),
  };
}
