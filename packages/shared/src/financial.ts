/** Exact fixed-point arithmetic. Public/persisted values are JSON-safe decimal strings. */
export const FINANCIAL_SCALE = 18;
const SCALE = 10n ** BigInt(FINANCIAL_SCALE);
export const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,59})(?:\.\d{1,18})?$/;

export function toAtomic(value: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new Error(
      'Expected an unsigned decimal string (up to 60 integer and 18 fractional digits)',
    );
  }
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(FINANCIAL_SCALE, '0'));
}

export function fromAtomic(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(FINANCIAL_SCALE, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / SCALE}${fraction ? `.${fraction}` : ''}`;
}

export function addDecimal(left: string, right: string): string {
  const result = fromAtomic(toAtomic(left) + toAtomic(right));
  toAtomic(result); // Enforce persistence bounds after arithmetic.
  return result;
}

export function multiplyDecimal(left: string, right: string): string {
  const product = toAtomic(left) * toAtomic(right);
  if (product % SCALE !== 0n) {
    throw new Error(
      'Product requires more than 18 decimal places; explicit rounding policy required',
    );
  }
  const result = fromAtomic(product / SCALE);
  toAtomic(result);
  return result;
}
