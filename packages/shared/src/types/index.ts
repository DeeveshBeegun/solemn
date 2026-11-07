import type { z } from 'zod';
import type {
  tokenSchema,
  marketEventSchema,
  marketSnapshotSchema,
  tradingSignalSchema,
  orderSchema,
  positionSchema,
  tradeSchema,
  orderRequestSchema,
  orderStatusSchema,
} from '../schemas/index.js';

export type Token = z.infer<typeof tokenSchema>;
export type MarketEvent = z.infer<typeof marketEventSchema>;
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;
export type TradingSignal = z.infer<typeof tradingSignalSchema>;
export type Order = z.infer<typeof orderSchema>;
export type Position = z.infer<typeof positionSchema>;
export type Trade = z.infer<typeof tradeSchema>;
export type OrderRequest = z.infer<typeof orderRequestSchema>;
export type OrderStatus = z.infer<typeof orderStatusSchema>;
