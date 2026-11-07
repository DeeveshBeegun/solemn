import {
  marketEventSchema,
  orderSchema,
  tokenSchema,
  tradeSchema,
} from '@solemn/shared';
import type { MarketEvent, Order, Token, Trade } from '@solemn/shared';
import type { Database } from './client.js';
import { marketEvents, orders, tokens, trades } from './schema.js';

export function createRepository(db: Database) {
  return {
    async insertToken(input: Token) {
      return (
        await db.insert(tokens).values(tokenSchema.parse(input)).returning()
      )[0];
    },
    async insertMarketEvent(input: MarketEvent) {
      const event = marketEventSchema.parse(input);
      const rows = await db
        .insert(marketEvents)
        .values({
          ...event,
          slot: event.slot === null ? null : BigInt(event.slot),
        })
        .onConflictDoNothing({
          target: [marketEvents.source, marketEvents.sourceEventId],
        })
        .returning();
      // A duplicate leaves the original payload untouched, including original ingestion time.
      return rows[0] ?? null;
    },
    async insertOrder(input: Order) {
      return (
        await db.insert(orders).values(orderSchema.parse(input)).returning()
      )[0];
    },
    async insertTrade(input: Trade) {
      return (
        await db.insert(trades).values(tradeSchema.parse(input)).returning()
      )[0];
    },
  };
}
