import { stableHash, toAtomic } from '@solemn/shared';
import type {
  PaperAccountDefinition,
  PaperCommand,
  PaperPortfolioState,
} from '@solemn/shared';
import { evaluateTokenRisk, policyHash } from './tokenRiskEngine.js';
export function entryRiskReasons(
  command: Extract<PaperCommand, { type: 'ENTRY' }>,
  state: PaperPortfolioState,
  definition: PaperAccountDefinition,
): string[] {
  const { candidate, risk, at } = command,
    policy = definition.policy,
    reasons: string[] = [];
  if (state.status !== 'ACTIVE')
    reasons.push(
      state.status === 'HALTED'
        ? 'PORTFOLIO_HALTED'
        : 'PORTFOLIO_ENTRIES_BLOCKED',
      ...state.entryBlockReasons,
    );
  if (
    candidate.strategyId !== definition.strategyPolicy.strategyId ||
    candidate.strategyVersion !== definition.strategyPolicy.version ||
    candidate.configHash !== stableHash(definition.strategyPolicy)
  )
    reasons.push('SIGNAL_VERSION_MISMATCH');
  if (
    Date.parse(candidate.timestamp) > Date.parse(at) ||
    Date.parse(at) - Date.parse(candidate.timestamp) >
      policy.maxSignalAgeSeconds * 1000
  )
    reasons.push('SIGNAL_STALE_OR_FUTURE');
  if (state.positions.some((position) => position.signalId === candidate.id))
    reasons.push('SIGNAL_ALREADY_TRADED');
  const active = state.positions.filter(
    (position) => position.status !== 'CLOSED',
  );
  if (active.length >= policy.maxOpenPositions)
    reasons.push('MAX_OPEN_POSITIONS');
  if (active.some((position) => position.mint === candidate.mint))
    reasons.push('TOKEN_POSITION_ALREADY_EXISTS');
  if (
    state.positions.some(
      (position) =>
        position.mint === candidate.mint &&
        Date.parse(at) - Date.parse(position.openedAt) <
          policy.entryCooldownSeconds * 1000,
    )
  )
    reasons.push('ENTRY_COOLDOWN');
  if (state.positions.length >= 1000) reasons.push('REPLAY_POSITION_CAPACITY');
  if (toAtomic(state.availableCashUsd) < toAtomic(policy.minimumOrderUsd))
    reasons.push('INSUFFICIENT_CASH');
  const assessment = risk?.assessment;
  if (
    !assessment ||
    !risk ||
    risk.currentStatus !== 'ELIGIBLE' ||
    assessment.status !== 'ELIGIBLE'
  )
    reasons.push('TOKEN_RISK_NOT_ELIGIBLE');
  else if (
    assessment.tokenMint !== candidate.mint ||
    risk.currentRequestId !== assessment.requestId ||
    candidate.riskAssessmentId !== assessment.id
  )
    reasons.push('TOKEN_RISK_NOT_CURRENT');
  else if (
    Date.parse(risk.availableAt) > Date.parse(at) ||
    Date.parse(assessment.assessedAt) > Date.parse(at) ||
    !assessment.validUntil ||
    Date.parse(assessment.validUntil) <= Date.parse(at) ||
    Date.parse(at) - Date.parse(assessment.assessedAt) >=
      definition.strategyPolicy.maxRiskAgeSeconds * 1000
  )
    reasons.push('TOKEN_RISK_STALE_OR_FUTURE');
  else if (assessment.policyHash !== policyHash(definition.riskPolicy))
    reasons.push('RISK_POLICY_MISMATCH');
  else {
    const revalidated = evaluateTokenRisk(
      {
        tokenMint: candidate.mint,
        requestId: assessment.requestId,
        requestedAt: assessment.requestedAt,
        attempt: assessment.attempt,
        trigger: 'PAPER_ENTRY_GATE',
        previous: null,
      },
      assessment.evidence.jupiter,
      assessment.evidence.solana,
      definition.riskPolicy,
      at,
    );
    if (revalidated.status !== 'ELIGIBLE')
      reasons.push('TOKEN_RISK_REVALIDATION_FAILED', ...revalidated.reasons);
  }
  return [...new Set(reasons)];
}
