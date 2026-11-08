import type {
  MarketEvent,
  MarketSnapshot,
  Order,
  Token,
  Trade,
  TradingSignal,
} from '../packages/shared/src/index.js';

export const NOW = '2026-01-01T00:00:00.000Z';
export const LATER = '2026-01-01T00:00:01.000Z';
export const MINT = 'So11111111111111111111111111111111111111112';
export const OTHER_MINT = '11111111111111111111111111111111';
export const id = (value: number) =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

export const token: Token = {
  mintAddress: MINT,
  name: 'Fixture Token',
  symbol: 'FIX',
  decimals: 9,
  createdAt: NOW,
  discoveredAt: NOW,
  sourcePlatform: 'fixture',
  poolAddress: null,
  riskStatus: 'UNKNOWN',
  creatorAddress: null,
  bondingCurveAddress: null,
  migrationStatus: 'UNKNOWN',
  migratedAt: null,
  migrationObservedAt: null,
  migrationVenue: null,
};
export const event: MarketEvent = {
  id: id(1),
  tokenMint: MINT,
  eventType: 'POOL_CREATED',
  sourceEventId: 'fixture-tx:0:0',
  slot: '9007199254740993',
  transactionSignature: '1'.repeat(64),
  eventAt: NOW,
  ingestedAt: LATER,
  source: 'fixture',
  rawPayload: { amount: '0.000000001', logs: ['created'] },
  rawMessage: null,
};
export const snapshot: MarketSnapshot = {
  id: id(2),
  tokenMint: MINT,
  timestamp: NOW,
  priceUsd: '0.1',
  poolLiquidityUsd: '100',
  volumeUsd: '20',
  buyVolumeUsd: '12',
  sellVolumeUsd: '8',
  uniqueBuyerCount: 3,
  source: 'fixture',
  observedAt: NOW,
  maxAgeMs: 5000,
  volumeWindowSeconds: 60,
};
export const signal: TradingSignal = {
  id: id(3),
  tokenMint: MINT,
  signalType: 'HOLD',
  strategyId: 'fixture',
  strategyVersion: '1.0.0',
  timestamp: NOW,
  explanation: 'Test fixture only',
  marketSnapshot: snapshot,
  riskAssessment: {
    status: 'UNKNOWN',
    reasons: ['Not assessed'],
    assessedAt: NOW,
  },
};
export const order: Order = {
  id: id(4),
  tokenMint: MINT,
  side: 'BUY',
  executionMode: 'PAPER',
  requestedQuantity: '0.3',
  status: 'CREATED',
  createdAt: NOW,
  submittedAt: null,
  executedAt: null,
  estimatedFeesUsd: '0.01',
  actualFeesUsd: null,
};
export const trade: Trade = {
  id: id(5),
  orderId: order.id,
  tokenMint: MINT,
  side: 'BUY',
  executedQuantity: '0.3',
  executionPriceUsd: '0.1',
  feesUsd: '0.01',
  timestamp: LATER,
};
