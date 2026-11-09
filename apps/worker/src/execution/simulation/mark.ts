import { fromAtomic, toAtomic } from '@solemn/shared';
import type { ExecutionConfig, ExecutionObservation } from '@solemn/shared';
import { ceil, decimalUnits, quoteExactInput, scale } from './poolModels.js';
import { scenarioPool } from './executionSimulator.js';
import { networkFees } from './feeModel.js';
/** Executable full-size sell value, including fees once; no displayed-price liquidity assumption. */
export function executionMark(
  observation: ExecutionObservation,
  quantity: string,
  config: ExecutionConfig,
): { priceUsd: string; valueUsd: string } | null {
  try {
    if (
      !observation.pool ||
      observation.pool.availableAt > observation.receivedAt ||
      observation.pool.baseMint !== observation.mint ||
      observation.pool.poolAddress !== observation.poolAddress
    )
      return null;
    const p = scenarioPool(observation.pool, config),
      q = quoteExactInput(p, 'SELL', decimalUnits(quantity, p.baseDecimals));
    const network = networkFees(
      config,
      observation.receivedAt,
      observation.nativeUsd ?? null,
    );
    if (
      network.unknown ||
      (config.network.routeRequiresTip &&
        config.network.tipLamports !== '0' &&
        network.rate === null)
    )
      return null;
    const tip = config.network.routeRequiresTip
      ? ceil(
          BigInt(config.network.tipLamports) * (network.rate ?? 0n),
          1000000000n,
        )
      : 0n;
    const usd =
      (q.output * toAtomic(p.quoteUsd!)) / scale(p.quoteDecimals) -
      network.usd -
      tip;
    if (usd <= 0n) return null;
    return {
      valueUsd: fromAtomic(usd),
      priceUsd: fromAtomic((usd * scale(18)) / toAtomic(quantity)),
    };
  } catch {
    return null;
  }
}
