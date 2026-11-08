import type { JupiterObservation, MintSecurity, RiskJob } from '@solemn/shared';
import { id, MINT, NOW, OTHER_MINT } from '../../../tests/fixtures.js';
import { emptyJupiter, emptySecurity } from '../src/analysis/observations.js';
import {
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from '../src/analysis/tokenSecurity.js';

export { id, MINT, NOW, OTHER_MINT, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM };
export const job = (mint = MINT): RiskJob => ({
  tokenMint: mint,
  requestId: id(100),
  requestedAt: NOW,
  attempt: 1,
  trigger: 'TOKEN_CREATED',
  previous: null,
});
export function goodJupiter(mint = MINT, time = NOW): JupiterObservation {
  return {
    ...emptyJupiter(mint, time),
    state: 'OK',
    updatedAt: time,
    name: 'Risk Fixture',
    symbol: 'RISK',
    decimals: 9,
    tokenProgram: SPL_TOKEN_PROGRAM,
    liquidityUsd: '50000',
    usdPrice: '0.1',
    marketCapUsd: '100000',
    holderCount: '1000',
    isVerified: true,
    organicScore: '80',
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    topHoldersPercentage: '25',
    isSus: false,
    rawResponse: '{"fixture":true}',
  };
}
export function goodSecurity(mint = MINT, time = NOW): MintSecurity {
  return {
    ...emptySecurity(mint, time),
    state: 'OK',
    tokenProgram: SPL_TOKEN_PROGRAM,
    validMint: true,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    decimals: 9,
    supplyBaseUnits: '9007199254740993',
    supportedExtensions: true,
    contextSlot: '9007199254740993',
  };
}
export const jupiterPayload = (mint = MINT, time = NOW) => ({
  id: mint,
  name: 'Risk Fixture',
  symbol: 'RISK',
  decimals: 9,
  tokenProgram: SPL_TOKEN_PROGRAM,
  liquidity: 50000,
  usdPrice: 0.1,
  mcap: 100000,
  holderCount: 1000,
  organicScore: 80,
  isVerified: true,
  audit: {
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    topHoldersPercentage: 25,
    isSus: false,
  },
  updatedAt: time,
});

export function mintAccount(
  options: {
    mintActive?: boolean;
    freezeActive?: boolean;
    owner?: string;
    extensions?: { type: number; length: number }[];
  } = {},
) {
  const base = Buffer.alloc(82);
  base.writeUInt32LE(options.mintActive ? 1 : 0, 0);
  base.fill(2, 4, 36);
  base.writeBigUInt64LE(9007199254740993n, 36);
  base[44] = 9;
  base[45] = 1;
  base.writeUInt32LE(options.freezeActive ? 1 : 0, 46);
  base.fill(3, 50, 82);
  let data = base;
  if (options.extensions) {
    const padding = Buffer.alloc(84);
    padding[83] = 1;
    const extensions = options.extensions.map(({ type, length }) => {
      const tlv = Buffer.alloc(4 + length);
      tlv.writeUInt16LE(type, 0);
      tlv.writeUInt16LE(length, 2);
      return tlv;
    });
    data = Buffer.concat([base, padding, ...extensions]);
  }
  return {
    owner: options.owner ?? SPL_TOKEN_PROGRAM,
    executable: false,
    lamports: '1461600',
    data: [data.toString('base64'), 'base64'] as [string, 'base64'],
  };
}
