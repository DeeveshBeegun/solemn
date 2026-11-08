import { addDecimal, toAtomic } from '@solemn/shared';
import type { MarketCandle, MomentumFeatures } from '@solemn/shared';
import { exactRatio, unavailableRatio } from '../strategy/exactMath.js';

export function analyzeMomentum(
  input: readonly MarketCandle[],
  end: string,
): MomentumFeatures {
  const candles = input
    .filter((candle) => Date.parse(candle.endTime) <= Date.parse(end))
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const current = candles.at(-1);
  const window = (count: number) => {
    const list = candles.slice(-count);
    return list.length === count &&
      list.every(
        (candle, index) =>
          candle.complete &&
          Date.parse(candle.endTime) ===
            Date.parse(end) - (count - 1 - index) * 60000,
      )
      ? list
      : null;
  };
  const momentum = (minutes: number) => {
    const list = window(minutes + 1);
    const reference = list?.[0]?.close;
    return !list ||
      list.some((candle) => candle.close === null) ||
      !reference ||
      current?.close == null
      ? unavailableRatio('PRICE_HISTORY_UNAVAILABLE')
      : exactRatio(
          (toAtomic(current.close) - toAtomic(reference)) * 100n,
          toAtomic(reference),
        );
  };
  const recent = window(5),
    comparison = window(10);
  const sum = (
    list: MarketCandle[] | null,
    field: 'volumeUsd' | 'buyVolumeUsd' | 'sellVolumeUsd',
  ) => {
    if (!list || list.some((candle) => candle[field] === null)) return null;
    try {
      return list.reduce(
        (total, candle) => addDecimal(total, candle[field] as string),
        '0',
      );
    } catch {
      return null;
    }
  };
  const volume5mUsd = sum(recent, 'volumeUsd'),
    buyVolume5mUsd = sum(recent, 'buyVolumeUsd'),
    sellVolume5mUsd = sum(recent, 'sellVolumeUsd');
  const preceding = sum(comparison?.slice(0, 5) ?? null, 'volumeUsd');
  const volumeAcceleration =
    volume5mUsd === null || preceding === null
      ? unavailableRatio('VOLUME_COMPARISON_UNAVAILABLE')
      : exactRatio(toAtomic(volume5mUsd), toAtomic(preceding));
  const buySellRatio =
    buyVolume5mUsd === null || sellVolume5mUsd === null
      ? unavailableRatio('SIDE_VOLUME_UNAVAILABLE')
      : exactRatio(toAtomic(buyVolume5mUsd), toAtomic(sellVolume5mUsd));
  const buyers =
    recent && recent.every((candle) => candle.buyers !== null)
      ? new Set(recent.flatMap((candle) => candle.buyers ?? []))
      : null;
  const volatility5m =
    recent &&
    recent.every(
      (candle) =>
        candle.high !== null && candle.low !== null && candle.close !== null,
    )
      ? exactRatio(
          recent.reduce(
            (total, candle) =>
              total +
              toAtomic(candle.high as string) -
              toAtomic(candle.low as string),
            0n,
          ) * 100n,
          recent.reduce(
            (total, candle) => total + toAtomic(candle.close as string),
            0n,
          ),
        )
      : unavailableRatio('VOLATILITY_UNAVAILABLE');
  return {
    momentum1m: momentum(1),
    momentum5m: momentum(5),
    momentum15m: momentum(15),
    volumeAcceleration,
    buySellRatio,
    volatility5m,
    volume5mUsd,
    buyVolume5mUsd,
    sellVolume5mUsd,
    uniqueBuyers5m: buyers?.size ?? null,
    candleIds: candles.slice(-16).map((candle) => candle.id),
  };
}
