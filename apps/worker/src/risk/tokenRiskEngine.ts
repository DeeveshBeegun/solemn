import { createHash } from 'node:crypto';
import { tokenRiskAssessmentSchema } from '@solemn/shared';
import type {
  JupiterObservation,
  MintSecurity,
  RiskJob,
  RiskPolicy,
  TokenRiskAssessment,
} from '@solemn/shared';
import type { Config } from '../config/index.js';
import { analyzeLiquidity, isFresh } from '../analysis/liquidityAnalyzer.js';
import { analyzeHolders } from '../analysis/holderAnalyzer.js';
import {
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from '../analysis/tokenSecurity.js';

export function riskPolicy(config: Config): RiskPolicy {
  return {
    version: config.RISK_POLICY_VERSION,
    minLiquidityUsd: config.RISK_MIN_LIQUIDITY_USD,
    maxTopHoldersPercentage: config.RISK_MAX_TOP_HOLDERS_PERCENTAGE,
    maxLiquidityDropPercentage: config.RISK_MAX_LIQUIDITY_DROP_PERCENTAGE,
    maxDataAgeSeconds: config.RISK_MAX_DATA_AGE_SECONDS,
    requireHolderData: config.RISK_REQUIRE_HOLDER_DATA,
    requireExplicitSuspiciousFlag: config.RISK_REQUIRE_EXPLICIT_SUSPICIOUS_FLAG,
  };
}
export const policyHash = (policy: RiskPolicy) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(policy).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ),
    )
    .digest('hex');
function assessmentId(job: RiskJob): string {
  const hash = createHash('sha256')
    .update(`${job.requestId}:${job.attempt}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function evaluateTokenRisk(
  job: RiskJob,
  jupiter: JupiterObservation,
  solana: MintSecurity,
  policy: RiskPolicy,
  assessedAt: string,
): TokenRiskAssessment {
  const rejected: string[] = [],
    unknown: string[] = [];
  const rpcFresh =
    solana.state === 'OK' &&
    isFresh(solana.checkedAt, assessedAt, policy.maxDataAgeSeconds);
  const jupFresh =
    jupiter.state === 'OK' &&
    isFresh(jupiter.fetchedAt, assessedAt, policy.maxDataAgeSeconds) &&
    isFresh(jupiter.updatedAt, assessedAt, policy.maxDataAgeSeconds);
  if (rpcFresh) {
    if (
      solana.tokenProgram === null ||
      ![SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(solana.tokenProgram)
    )
      unknown.push('TOKEN_PROGRAM_UNVERIFIED');
    if (solana.validMint === false)
      rejected.push(
        solana.issues.includes('UNSUPPORTED_TOKEN_PROGRAM')
          ? 'UNSUPPORTED_TOKEN_PROGRAM'
          : 'INVALID_MINT',
      );
    if (solana.mintAuthorityDisabled === false)
      rejected.push('MINT_AUTHORITY_ACTIVE');
    if (solana.freezeAuthorityDisabled === false)
      rejected.push('FREEZE_AUTHORITY_ACTIVE');
    for (const extension of solana.extensions)
      if (extension.policy === 'REJECT' && solana.validMint === true)
        rejected.push(
          `PROHIBITED_${extension.name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`,
        );
    if (
      solana.validMint !== true ||
      solana.mintAuthorityDisabled === null ||
      solana.freezeAuthorityDisabled === null ||
      solana.supportedExtensions !== true
    )
      unknown.push('SECURITY_STATE_UNVERIFIED');
  } else
    unknown.push(
      solana.state === 'ERROR'
        ? 'RPC_UNAVAILABLE'
        : solana.state === 'MISSING'
          ? 'MINT_NOT_FOUND'
          : 'SECURITY_DATA_STALE',
    );
  if (jupFresh && jupiter.isSus === true)
    rejected.push('SUSPICIOUS_PROVIDER_FLAG');
  if (!jupFresh)
    unknown.push(
      jupiter.state === 'MISSING'
        ? 'JUPITER_NOT_INDEXED'
        : jupiter.state === 'ERROR'
          ? 'JUPITER_UNAVAILABLE'
          : 'JUPITER_DATA_STALE',
    );
  if (jupiter.issues.length) unknown.push('JUPITER_DATA_INVALID');
  if (jupFresh && rpcFresh) {
    if (
      (jupiter.tokenProgram !== null &&
        jupiter.tokenProgram !== solana.tokenProgram) ||
      (jupiter.decimals !== null &&
        solana.decimals !== null &&
        jupiter.decimals !== solana.decimals) ||
      (jupiter.mintAuthorityDisabled !== null &&
        solana.mintAuthorityDisabled !== null &&
        jupiter.mintAuthorityDisabled !== solana.mintAuthorityDisabled) ||
      (jupiter.freezeAuthorityDisabled !== null &&
        solana.freezeAuthorityDisabled !== null &&
        jupiter.freezeAuthorityDisabled !== solana.freezeAuthorityDisabled)
    )
      unknown.push('CONFLICTING_SOURCES');
  }
  if (
    policy.requireExplicitSuspiciousFlag &&
    (!jupFresh || jupiter.isSus === null)
  )
    unknown.push('SUSPICIOUS_FLAG_UNAVAILABLE');
  const liquidity = analyzeLiquidity(jupiter, policy, assessedAt, job.previous);
  if (!liquidity.available) unknown.push('LIQUIDITY_UNAVAILABLE_OR_STALE');
  if (liquidity.belowMinimum) rejected.push('LIQUIDITY_BELOW_MINIMUM');
  if (liquidity.deteriorated) rejected.push('LIQUIDITY_DETERIORATION');
  const holders = analyzeHolders(jupiter, policy, assessedAt);
  if (holders.aboveMaximum) rejected.push('HOLDER_CONCENTRATION_HIGH');
  if (policy.requireHolderData && !holders.available)
    unknown.push('HOLDER_DATA_UNAVAILABLE');
  const previousTime = job.previous?.evidence.jupiter.updatedAt;
  if (
    jupFresh &&
    previousTime &&
    Date.parse(jupiter.updatedAt as string) < Date.parse(previousTime)
  )
    unknown.push('PROVIDER_OBSERVATION_REGRESSED');
  const status = rejected.length
    ? 'REJECTED'
    : unknown.length
      ? 'UNKNOWN'
      : 'ELIGIBLE';
  const evidenceTimes = [
    rpcFresh ? solana.checkedAt : null,
    jupFresh ? jupiter.updatedAt : null,
    jupFresh ? jupiter.fetchedAt : null,
  ].filter((value): value is string => value !== null);
  const validUntil =
    status === 'UNKNOWN' || !evidenceTimes.length
      ? null
      : new Date(
          Math.min(...evidenceTimes.map(Date.parse)) +
            policy.maxDataAgeSeconds * 1000,
        ).toISOString();
  return tokenRiskAssessmentSchema.parse({
    id: assessmentId(job),
    tokenMint: job.tokenMint,
    requestId: job.requestId,
    attempt: job.attempt,
    requestedAt: job.requestedAt,
    status,
    reasons: [...new Set([...rejected, ...unknown])]
      .sort()
      .concat(status === 'ELIGIBLE' ? ['ALL_MANDATORY_CHECKS_PASSED'] : []),
    checks: {
      tokenProgram: solana.tokenProgram,
      mintAuthorityDisabled: solana.mintAuthorityDisabled,
      freezeAuthorityDisabled: solana.freezeAuthorityDisabled,
      supportedExtensions: solana.supportedExtensions,
      liquidityUsd: jupiter.liquidityUsd,
      liquidityFresh: liquidity.fresh,
      topHoldersPercentage: jupiter.topHoldersPercentage,
      suspiciousProviderFlag: jupiter.isSus,
      liquidityDeteriorated: liquidity.deteriorated,
      previousLiquidityUsd: liquidity.previousLiquidityUsd,
    },
    policy,
    policyHash: policyHash(policy),
    assessedAt,
    validUntil,
    evidence: {
      jupiter,
      solana,
      previousAssessmentId: job.previous?.id ?? null,
    },
  });
}
