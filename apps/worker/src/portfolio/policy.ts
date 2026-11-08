import { paperPolicySchema } from '@solemn/shared';
import type { Config } from '../config/index.js';
export function paperPolicy(config: Config) {
  return paperPolicySchema.parse({
    version: 'solemn-paper-v1',
    initialBalanceUsd: config.INITIAL_PAPER_BALANCE_USD,
    maxPositionPercent: config.PAPER_MAX_POSITION_PERCENT,
    maxOpenPositions: config.PAPER_MAX_OPEN_POSITIONS,
    stopLossPercent: config.PAPER_STOP_LOSS_PERCENT,
    takeProfit1Percent: config.PAPER_TAKE_PROFIT_1_PERCENT,
    takeProfit1Fraction: config.PAPER_TAKE_PROFIT_1_SELL_FRACTION,
    takeProfit2Percent: config.PAPER_TAKE_PROFIT_2_PERCENT,
    takeProfit2Fraction: config.PAPER_TAKE_PROFIT_2_SELL_FRACTION,
    trailingStopPercent: config.PAPER_TRAILING_STOP_PERCENT,
    maxHoldingMinutes: config.PAPER_MAX_HOLDING_MINUTES,
    maxDailyLossPercent: config.PAPER_MAX_DAILY_LOSS_PERCENT,
    maxTotalDrawdownPercent: config.PAPER_MAX_TOTAL_DRAWDOWN_PERCENT,
    buyFeePercent: config.PAPER_BUY_FEE_PERCENT,
    sellFeePercent: config.PAPER_SELL_FEE_PERCENT,
    slippagePercent: config.PAPER_BASELINE_SLIPPAGE_PERCENT,
    maxLiquidityParticipationPercent:
      config.PAPER_MAX_LIQUIDITY_PARTICIPATION_PERCENT,
    minimumOrderUsd: config.PAPER_MIN_ORDER_USD,
    quantityDecimals: config.PAPER_QUANTITY_DECIMALS,
    maxPriceAgeSeconds: config.PAPER_MAX_PRICE_AGE_SECONDS,
    maxSignalAgeSeconds: config.PAPER_MAX_SIGNAL_AGE_SECONDS,
    entryCooldownSeconds: config.PAPER_ENTRY_COOLDOWN_SECONDS,
  });
}
