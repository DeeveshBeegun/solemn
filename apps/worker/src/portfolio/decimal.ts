import { fromAtomic, toAtomic } from '@solemn/shared';
export const SCALE = 10n ** 18n,
  HUNDRED = 100n * SCALE;
export const signed = (value: string) =>
  value.startsWith('-') ? -toAtomic(value.slice(1)) : toAtomic(value);
export const ceilDivide = (n: bigint, d: bigint) => {
  if (n < 0n || d <= 0n) throw new Error('Invalid nonnegative division');
  return (n + d - 1n) / d;
};
export const multiplyDown = (a: string, b: string) =>
  fromAtomic((toAtomic(a) * toAtomic(b)) / SCALE);
export const moneyNotional = (
  quantity: string,
  price: string,
  side: 'BUY' | 'SELL',
) =>
  side === 'BUY'
    ? ceilDivide(toAtomic(quantity) * toAtomic(price), SCALE)
    : (toAtomic(quantity) * toAtomic(price)) / SCALE;
export const feeFor = (notional: bigint, percent: string) =>
  ceilDivide(notional * toAtomic(percent), HUNDRED);
export const percentOf = (amount: bigint, percent: string) =>
  (amount * toAtomic(percent)) / HUNDRED;
export const quantityStep = (decimals: number) => 10n ** BigInt(18 - decimals);
export const quantize = (quantity: bigint, decimals: number) =>
  (quantity / quantityStep(decimals)) * quantityStep(decimals);
export const percentage = (numerator: bigint, denominator: bigint) =>
  denominator === 0n ? '0' : fromAtomic((numerator * HUNDRED) / denominator);
