import {
  getAddressDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import { stableId } from '@solemn/shared';
import type { PoolSnapshot } from '@solemn/shared';
import { paperEntrySetup, paperConfig } from './paperFixtures.js';
import { usdc, wrappedSol } from '../src/execution/jupiter/amounts.js';
import {
  computeBudgetProgram,
  jupiterV6Program,
} from '../src/execution/jupiter/transactionInspector.js';
import type { SwapRequest } from '../src/execution/jupiter/amounts.js';
import type { Config } from '../src/config/index.js';

export const address = (value: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(value));
export const taker = address(91);
export const quoteRequest: SwapRequest = {
  inputMint: wrappedSol,
  outputMint: usdc,
  amount: '10000000',
  inputDecimals: 9,
  outputDecimals: 6,
  excludeRouters: [],
};
export const swapConfig: Config = {
  ...paperConfig,
  JUPITER_SWAP_ENABLED: true,
  JUPITER_SWAP_BASE_URL: 'http://localhost:1234/swap/v2',
  RISK_HTTP_RETRY_MS: 1,
  RISK_RPC_REQUEST_INTERVAL_MS: 1,
};
export function providerQuote(
  request: SwapRequest = quoteRequest,
  overrides: Record<string, unknown> = {},
) {
  return {
    mode: 'ultra',
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inAmount: request.amount,
    outAmount: '800000',
    otherAmountThreshold: '792000',
    swapMode: 'ExactIn',
    slippageBps: 100,
    priceImpact: -0.12,
    routePlan: [
      {
        bps: 10000,
        swapInfo: {
          ammKey: address(23),
          label: 'Untrusted text is discarded',
          inputMint: request.inputMint,
          outputMint: request.outputMint,
          inAmount: request.amount,
          outAmount: '800000',
        },
      },
    ],
    router: 'metis',
    requestId: 'fixture-request',
    feeBps: 5,
    feeMint: request.inputMint,
    platformFee: { feeBps: 5, feeMint: request.inputMint },
    signatureFeeLamports: 5000,
    prioritizationFeeLamports: 1000,
    rentFeeLamports: 0,
    transaction: null,
    taker: null,
    ...overrides,
  };
}

export function unsignedFixture(
  options: {
    payer?: ReturnType<typeof address>;
    program?: string;
    lookup?: boolean;
    version?: 0 | 'legacy';
    signed?: boolean;
    badBlockhash?: boolean;
  } = {},
) {
  const {
    payer = taker,
    program = computeBudgetProgram,
    version = 0,
  } = options;
  const knownProgram = program === computeBudgetProgram;
  const message = getCompiledTransactionMessageEncoder().encode({
    version,
    lifetimeToken: options.badBlockhash ? address(0) : address(33),
    header: {
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: 1,
    },
    staticAccounts: [payer, program as typeof payer],
    instructions: [
      {
        programAddressIndex: 1,
        accountIndices: knownProgram ? [] : [0],
        data: knownProgram
          ? Uint8Array.of(2, 160, 134, 1, 0)
          : new Uint8Array(8),
      },
    ],
    ...(options.lookup
      ? {
          addressTableLookups: [
            {
              lookupTableAddress: address(98),
              writableIndexes: [0],
              readonlyIndexes: [],
            },
          ],
        }
      : {}),
  });
  return Buffer.concat([
    Buffer.of(1),
    Buffer.alloc(64, options.signed ? 1 : 0),
    Buffer.from(message),
  ]).toString('base64');
}
export function opaqueSwapFixture(request: SwapRequest = quoteRequest) {
  const staticAccounts = [
    taker,
    address(31),
    address(32),
    address(33),
    address(34),
    address(35),
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    request.inputMint,
    request.outputMint,
    address(37),
    jupiterV6Program,
  ] as ReturnType<typeof address>[];
  const message = getCompiledTransactionMessageEncoder().encode({
    version: 0,
    lifetimeToken: address(38),
    staticAccounts,
    header: {
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: 5,
    },
    instructions: [
      {
        programAddressIndex: 10,
        accountIndices: [6, 5, 0, 1, 2, 3, 4, 7, 8, 3, 9],
        data: Buffer.from('79eea60b6e928189', 'hex'),
      },
    ],
  });
  return Buffer.concat([
    Buffer.of(1),
    Buffer.alloc(64),
    Buffer.from(message),
  ]).toString('base64');
}

export async function entryFixture() {
  const base = await paperEntrySetup();
  const { command } = base;
  if (!command.observation) throw new Error('Missing market fixture');
  const pool: PoolSnapshot = {
    id: stableId(['jupiter-test-pool']),
    poolAddress: command.candidate.poolAddress,
    baseMint: command.candidate.mint,
    quoteMint: wrappedSol,
    model: 'REFERENCE_CPMM_V1',
    baseDecimals: 9,
    quoteDecimals: 9,
    baseReserve: '10000000000000',
    quoteReserve: '100000000000',
    quoteUsd: '80',
    observedAt: command.observation.observedAt,
    availableAt: command.observation.receivedAt,
    source: 'SOLEMN_TEST_FIXTURE',
    quality: 'SYNTHETIC',
    transfers: 'ENABLED',
    fees: {
      source: 'SOLEMN_TEST_FIXTURE',
      kind: 'RESEARCH',
      validFrom: base.definition.createdAt,
      validUntil: new Date(Date.parse(command.at) + 3600000).toISOString(),
      lpBps: 30,
      protocolBps: 0,
      creatorBps: 0,
      routingBps: 0,
      integratorBps: 0,
    },
    baseTransferFee: null,
    quoteTransferFee: null,
    networkHint: 'NORMAL',
  };
  command.observation.pool = pool;
  const now = Date.parse(command.observation.receivedAt);
  const request = {
    ...quoteRequest,
    outputMint: command.candidate.mint,
    outputDecimals: 9,
  };
  return { ...base, request, now };
}
