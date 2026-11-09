import { stableHash, toAtomic } from '@solemn/shared';
import type { PaperPosition, StrategyDecision } from '@solemn/shared';
import { percentage, signed } from '../portfolio/decimal.js';
import { inPeriod } from './contracts.js';
import type { CapturedPortfolio, AttributionEvent } from './contracts.js';

const riskRejection =
  /^(PORTFOLIO_|TOKEN_RISK_|RISK_POLICY_|SIGNAL_|MAX_OPEN_|TOKEN_POSITION_|ENTRY_COOLDOWN|REPLAY_POSITION_|INSUFFICIENT_CASH|NO_VALID_POSITION_SIZE|DAILY_LOSS_|TOTAL_DRAWDOWN_)/;
const missingObservation =
  /OBSERVATION|MARKET_DATA|LIQUIDITY_UNAVAILABLE|FEED_DISCONNECTED/;
const count = (n: number, d: number) =>
  d ? percentage(BigInt(n), BigInt(d)) : null;
const intersection = (a: readonly string[], b: readonly string[]) => {
  const other = new Set(b);
  return a.filter((v) => other.has(v)).length;
};
const latestIntent = (a: AttributionEvent | undefined, b: AttributionEvent) =>
  !a ||
  a.status === 'PENDING' ||
  (b.status !== 'PENDING' && Date.parse(b.at ?? '') >= Date.parse(a.at ?? ''));
function classify(
  position: PaperPosition | undefined,
  created: boolean,
  uncertain: boolean,
  reasons: string[],
  intent: AttributionEvent | undefined,
) {
  if (position) {
    if (position.status === 'EXIT_BLOCKED') return 'EXIT_BLOCKED';
    if (position.status !== 'CLOSED') return 'POSITION_OPEN';
    const net = signed(position.realizedPnlUsd);
    return net > 0n
      ? 'CLOSED_WIN'
      : net < 0n
        ? 'CLOSED_LOSS'
        : 'CLOSED_BREAKEVEN';
  }
  if (uncertain) return 'ENTRY_UNVERIFIABLE';
  if (created) return 'ENTRY_FAILED';
  if (reasons.some((reason) => riskRejection.test(reason)))
    return 'RISK_REJECTED';
  if (
    intent?.status === 'EXPIRED' ||
    intent?.status === 'UNFILLED' ||
    reasons.some((r) => missingObservation.test(r))
  )
    return 'NO_EXECUTION_OBSERVATION';
  if (intent?.status === 'CANCELLED' || intent?.status === 'SKIPPED')
    return 'ENTRY_CANCELLED';
  return 'OUTCOME_UNAVAILABLE';
}

function features(input: CapturedPortfolio, decision: StrategyDecision) {
  const candidate = decision.candidate!;
  const market = input.markets.find(
    (m) => m.mint === candidate.mint && m.poolAddress === candidate.poolAddress,
  );
  const poolAgeMinutes =
    market?.poolCreatedAt &&
    market.poolCreationAvailableAt &&
    Date.parse(market.poolCreationAvailableAt) <=
      Date.parse(candidate.timestamp) &&
    Date.parse(market.poolCreatedAt) <= Date.parse(candidate.timestamp)
      ? percentage(
          BigInt(
            Date.parse(candidate.timestamp) - Date.parse(market.poolCreatedAt),
          ),
          6000000n,
        )
      : null;
  const pattern = decision.stateBefore.breakout;
  const resistance = pattern.resistance ? toAtomic(pattern.resistance) : null,
    low = pattern.pullbackLow ? toAtomic(pattern.pullbackLow) : null;
  const reference = toAtomic(candidate.breakoutReference);
  return {
    poolAgeMinutes,
    liquidityUsd: candidate.liquidityUsd,
    volumeAcceleration: candidate.features.volumeAcceleration.value,
    buySellRatio: candidate.features.buySellRatio.value,
    uniqueBuyers5m: candidate.features.uniqueBuyers5m,
    momentum1mPercent: candidate.features.momentum1m.value,
    momentum5mPercent: candidate.features.momentum5m.value,
    volatility5mPercent: candidate.features.volatility5m.value,
    pullbackPercent:
      resistance && low !== null
        ? percentage(resistance - low, resistance)
        : null,
    breakoutStrengthPercent: percentage(
      toAtomic(candidate.referencePriceUsd) - reference,
      reference,
    ),
  };
}
export function analyzeSignals(input: CapturedPortfolio) {
  const positions = new Map(
    input.endState.positions.map((p) => [p.signalId, p]),
  );
  const intents = new Map<string, AttributionEvent>();
  for (const i of input.intents)
    if (latestIntent(intents.get(i.signalId), i)) intents.set(i.signalId, i);
  const entries = new Map<string, (typeof input.journal)[number]>();
  for (const event of input.journal)
    if (event.command?.type === 'ENTRY')
      entries.set(event.command.candidate.id, event);
  const candidates = new Map<string, StrategyDecision>();
  let duplicates = 0;
  for (const d of input.decisions) {
    const c = d.candidate;
    if (!c || !inPeriod(c.timestamp, input.start, input.end)) continue;
    if (
      c.strategyId !== input.strategyId ||
      c.strategyVersion !== input.definition.strategyPolicy.version ||
      c.configHash !== stableHash(input.definition.strategyPolicy) ||
      Date.parse(c.timestamp) !== Date.parse(d.timestamp)
    )
      throw new Error('Signal does not match the frozen strategy');
    const previous = candidates.get(c.id);
    if (previous) {
      if (stableHash(previous.candidate) !== stableHash(c))
        throw new Error('Conflicting duplicate signal');
      duplicates++;
      continue;
    }
    candidates.set(c.id, d);
  }
  const rows = [...candidates].map(([signalId, d]) => {
    const c = d.candidate!,
      p = positions.get(signalId),
      e = entries.get(signalId),
      i = intents.get(signalId),
      order = e?.orders.find((o) => o.order.side === 'BUY');
    const reasons = [
      ...new Set([...(e?.result.reasons ?? []), ...(i?.reasons ?? [])]),
    ];
    return {
      signalId,
      mint: c.mint,
      signalAt: c.timestamp,
      orderId: order?.order.id ?? null,
      positionId: p?.id ?? null,
      entryFilled: order?.order.status === 'FILLED' || !!p,
      orderCreated: !!order,
      acceptedIntent: !!i || !!order,
      outcome: classify(
        p,
        !!order,
        order?.audit?.outcome === 'UNVERIFIABLE',
        reasons,
        i,
      ),
      reasons,
      features: features(input, d),
    };
  });
  const { discovered, analyzed, eligible, watched } = input.observations;
  const tokens = [...new Set(rows.map((r) => r.mint))];
  const filled = rows.filter((r) => r.entryFilled).length,
    approved = rows.filter((r) => r.orderCreated).length,
    closed = rows.filter((r) => r.outcome.startsWith('CLOSED_')).length;
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return {
    rows,
    funnel: {
      discoveredTokens: discovered?.length ?? null,
      analyzedTokens: analyzed?.length ?? null,
      eligibleTokens: eligible?.length ?? null,
      watchedTokens: watched?.length ?? null,
      distinctSignalTokens: tokens.length,
      buyCandidates: rows.length,
      duplicates,
      acceptedIntents: rows.filter((r) => r.acceptedIntent).length,
      riskApprovedOrders: approved,
      filledEntries: filled,
      closedPositions: closed,
      outcomes,
      discoveredToAnalyzedPercent:
        discovered && analyzed
          ? count(intersection(discovered, analyzed), discovered.length)
          : null,
      analyzedToEligiblePercent:
        analyzed && eligible
          ? count(intersection(analyzed, eligible), analyzed.length)
          : null,
      eligibleToSignalTokenPercent: eligible
        ? count(intersection(eligible, tokens), eligible.length)
        : null,
      candidateToOrderPercent: count(approved, rows.length),
      orderToFillPercent: count(filled, approved),
      fillToClosedPercent: count(closed, filled),
    },
  };
}
export type SignalRow = ReturnType<typeof analyzeSignals>['rows'][number];
