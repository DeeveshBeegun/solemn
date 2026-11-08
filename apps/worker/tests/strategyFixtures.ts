import type {
  MarketCandle,
  MarketCorrection,
  StrategyDecision,
} from '@solemn/shared';
import type { StrategyRepository } from '@solemn/database';
import { loadConfig } from '../src/config/index.js';
export const strategyConfig = loadConfig({
  DATABASE_URL: 'postgresql://solemn:password@localhost:55432/solemn',
});
export function memoryStrategyRepository() {
  const decisions = new Map<string, StrategyDecision>(),
    candles = new Map<string, MarketCandle>(),
    corrections = new Map<string, MarketCorrection>();
  const repository: StrategyRepository = {
    async begin() {},
    async save(_run, decision, items, changes) {
      items.forEach((item) => candles.set(item.id, item));
      changes.forEach((item) => corrections.set(item.id, item));
      if (decisions.has(decision.id)) return 'DUPLICATE';
      decisions.set(decision.id, decision);
      return 'INSERTED';
    },
  };
  return { repository, decisions, candles, corrections };
}
