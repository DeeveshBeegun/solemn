import type { JupiterObservation, MintSecurity } from '@solemn/shared';

export function emptyJupiter(
  mint: string,
  fetchedAt: string,
): JupiterObservation {
  return {
    source: 'JUPITER_V2',
    mint,
    state: 'MISSING',
    fetchedAt,
    updatedAt: null,
    name: null,
    symbol: null,
    decimals: null,
    tokenProgram: null,
    usdPrice: null,
    liquidityUsd: null,
    marketCapUsd: null,
    activity: null,
    holderCount: null,
    isVerified: null,
    organicScore: null,
    mintAuthorityDisabled: null,
    freezeAuthorityDisabled: null,
    topHoldersPercentage: null,
    isSus: null,
    issues: [],
    rawResponse: null,
    error: null,
  };
}
export function emptySecurity(mint: string, checkedAt: string): MintSecurity {
  return {
    source: 'SOLANA_RPC',
    mint,
    state: 'MISSING',
    checkedAt,
    commitment: 'confirmed',
    contextSlot: null,
    tokenProgram: null,
    validMint: null,
    mintAuthorityDisabled: null,
    freezeAuthorityDisabled: null,
    decimals: null,
    supplyBaseUnits: null,
    supportedExtensions: null,
    extensions: [],
    issues: [],
    accountDataBase64: null,
    error: null,
  };
}

/** Expand provider exponents using string operations, with no Number conversion or rounding. */
export function providerDecimal(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !/^\d+(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(value)
  )
    return null;
  const [mantissa = '', exponent = '0'] = value.toLowerCase().split('e');
  const [integer = '', fraction = ''] = mantissa.split('.');
  const shift = Number(exponent); // A bounded exponent, never an amount.
  if (Math.abs(shift) > 100) return null;
  const digits = integer + fraction;
  const point = integer.length + shift;
  let expanded =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${'0'.repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  let [whole = '', part = ''] = expanded.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  part = part.replace(/0+$/, '');
  expanded = whole + (part ? `.${part}` : '');
  return whole.length <= 60 && part.length <= 18 ? expanded : null;
}
