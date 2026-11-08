import { toAtomic } from '@solemn/shared';
import type {
  BreakoutState,
  MarketCandle,
  StrategyPolicy,
} from '@solemn/shared';

export const emptyBreakout = (): BreakoutState => ({
  stage: 'WAITING_FOR_HISTORY',
  spikeCandleId: null,
  spikeAt: null,
  resistance: null,
  pullbackCandleId: null,
  pullbackLow: null,
});
const overBuffer = (price: string, reference: string, percent: string) =>
  toAtomic(price) * toAtomic('100') >
  toAtomic(reference) * (toAtomic('100') + toAtomic(percent));

export function detectBreakout(
  previous: BreakoutState,
  history: readonly MarketCandle[],
  current: MarketCandle,
  policy: StrategyPolicy,
  entryConfirmed: boolean,
) {
  let state = structuredClone(previous);
  const transitions: string[] = [];
  const move = (next: BreakoutState['stage']) => {
    if (state.stage !== next) transitions.push(`${state.stage}->${next}`);
    state.stage = next;
  };
  if (
    state.spikeAt &&
    Date.parse(current.endTime) - Date.parse(state.spikeAt) >
      policy.patternMaxAgeSeconds * 1000
  ) {
    state = { ...emptyBreakout(), stage: 'OBSERVING_MOMENTUM' };
    transitions.push(`${previous.stage}->OBSERVING_MOMENTUM`);
    return { state, transitions, reason: 'PATTERN_EXPIRED', breakout: false };
  }
  if (state.stage === 'WAITING_FOR_HISTORY' || state.stage === 'BUY_CANDIDATE')
    move('OBSERVING_MOMENTUM');
  if (state.stage === 'OBSERVING_MOMENTUM') {
    const prior = history
      .filter(
        (candle) => Date.parse(candle.endTime) < Date.parse(current.endTime),
      )
      .slice(-policy.breakoutLookbackCandles);
    const high = prior.reduce<string | null>(
      (value, candle) =>
        candle.high !== null &&
        (value === null || toAtomic(candle.high) > toAtomic(value))
          ? candle.high
          : value,
      null,
    );
    if (
      prior.length === policy.breakoutLookbackCandles &&
      high &&
      current.close &&
      current.high &&
      overBuffer(current.close, high, policy.minInitialSpikePercentage)
    ) {
      move('INITIAL_SPIKE_DETECTED');
      state.spikeCandleId = current.id;
      state.spikeAt = current.endTime;
      state.resistance = current.high;
      state.pullbackCandleId = null;
      state.pullbackLow = null;
      return {
        state,
        transitions,
        reason: 'INITIAL_SPIKE_DETECTED',
        breakout: false,
      };
    }
    return {
      state,
      transitions,
      reason: 'OBSERVING_MOMENTUM',
      breakout: false,
    };
  }
  if (
    state.stage === 'INITIAL_SPIKE_DETECTED' &&
    state.resistance &&
    current.high &&
    current.low &&
    current.close
  ) {
    if (toAtomic(current.high) > toAtomic(state.resistance)) {
      state.resistance = current.high;
      state.spikeCandleId = current.id;
      state.spikeAt = current.endTime;
      return {
        state,
        transitions,
        reason: 'SPIKE_REFERENCE_UPDATED_BEFORE_PULLBACK',
        breakout: false,
      };
    }
    if (
      toAtomic(current.low) * toAtomic('100') <=
        toAtomic(state.resistance) *
          (toAtomic('100') - toAtomic(policy.minPullbackPercentage)) &&
      toAtomic(current.close) < toAtomic(state.resistance)
    ) {
      move('PULLBACK_CONFIRMED');
      state.pullbackCandleId = current.id;
      state.pullbackLow = current.low;
      return {
        state,
        transitions,
        reason: 'PULLBACK_CONFIRMED',
        breakout: false,
      };
    }
  }
  if (
    state.stage === 'PULLBACK_CONFIRMED' &&
    state.resistance &&
    current.close
  ) {
    if (
      state.pullbackLow &&
      toAtomic(current.close) * toAtomic('100') <
        toAtomic(state.pullbackLow) *
          (toAtomic('100') - toAtomic(policy.breakoutBufferPercentage))
    ) {
      move('OBSERVING_MOMENTUM');
      state = { ...emptyBreakout(), stage: 'OBSERVING_MOMENTUM' };
      return { state, transitions, reason: 'PULLBACK_FAILED', breakout: false };
    }
    if (
      overBuffer(
        current.close,
        state.resistance,
        policy.breakoutBufferPercentage,
      )
    ) {
      if (!entryConfirmed)
        return {
          state,
          transitions,
          reason: 'BREAKOUT_ACTIVITY_NOT_CONFIRMED',
          breakout: false,
        };
      move('BREAKOUT_CONFIRMED');
      move('BUY_CANDIDATE');
      return {
        state,
        transitions,
        reason: 'BREAKOUT_CONFIRMED',
        breakout: true,
      };
    }
  }
  return {
    state,
    transitions,
    reason:
      state.stage === 'PULLBACK_CONFIRMED'
        ? 'BREAKOUT_NOT_CONFIRMED'
        : 'PULLBACK_NOT_CONFIRMED',
    breakout: false,
  };
}
