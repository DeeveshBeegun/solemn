import { fromAtomic, toAtomic } from '@solemn/shared';
import type { Ratio } from '@solemn/shared';

const SCALE = 10n ** 18n;
export const signedAtomic = (value: string) =>
  value.startsWith('-') ? -toAtomic(value.slice(1)) : toAtomic(value);
export function unavailableRatio(reason: string): Ratio {
  return {
    state: 'UNAVAILABLE',
    numerator: null,
    denominator: null,
    value: null,
    reason,
  };
}
export function exactRatio(numerator: bigint, denominator: bigint): Ratio {
  return {
    state: denominator === 0n ? 'ZERO_DENOMINATOR' : 'AVAILABLE',
    numerator: fromAtomic(numerator),
    denominator: fromAtomic(denominator),
    value:
      denominator === 0n ? null : fromAtomic((numerator * SCALE) / denominator),
    reason: denominator === 0n ? 'ZERO_DENOMINATOR' : null,
  };
}
// Comparisons use original rational components, never the truncated display value.
export function ratioAtLeast(ratio: Ratio, threshold: string): boolean {
  if (
    ratio.state !== 'AVAILABLE' ||
    ratio.numerator === null ||
    ratio.denominator === null
  )
    return false;
  const n = ratio.numerator.startsWith('-')
    ? -decimalComponent(ratio.numerator.slice(1))
    : decimalComponent(ratio.numerator);
  return n * SCALE >= toAtomic(threshold) * decimalComponent(ratio.denominator);
}
function decimalComponent(value: string): bigint {
  const [whole = '0', part = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(part.padEnd(18, '0'));
}
export const ratioPositive = (ratio: Ratio) =>
  ratio.state === 'AVAILABLE' &&
  ratio.numerator !== null &&
  !ratio.numerator.startsWith('-') &&
  decimalComponent(ratio.numerator) > 0n;
export function ratioAtMost(ratio: Ratio, threshold: string): boolean {
  if (
    ratio.state !== 'AVAILABLE' ||
    ratio.numerator === null ||
    ratio.denominator === null
  )
    return false;
  const n = ratio.numerator.startsWith('-')
    ? -decimalComponent(ratio.numerator.slice(1))
    : decimalComponent(ratio.numerator);
  return n * SCALE <= toAtomic(threshold) * decimalComponent(ratio.denominator);
}
