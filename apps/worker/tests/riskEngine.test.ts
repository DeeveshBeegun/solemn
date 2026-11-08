import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import {
  evaluateTokenRisk,
  policyHash,
  riskPolicy,
} from '../src/risk/tokenRiskEngine.js';
import { analyzeLiquidity } from '../src/analysis/liquidityAnalyzer.js';
import { emptyJupiter } from '../src/analysis/observations.js';
import { goodJupiter, goodSecurity, job, MINT, NOW } from './riskFixtures.js';

const policy = riskPolicy(
  loadConfig({ DATABASE_URL: 'postgresql://localhost/solemn' }),
);
describe('deterministic token risk policy', () => {
  it('allows only complete mandatory checks and records an expiry', () => {
    const result = evaluateTokenRisk(
      job(),
      goodJupiter(),
      goodSecurity(),
      policy,
      NOW,
    );
    expect(result.status).toBe('ELIGIBLE');
    expect(result.reasons).toEqual(['ALL_MANDATORY_CHECKS_PASSED']);
    expect(result.validUntil).toBe('2026-01-01T00:01:00.000Z');
    expect(
      evaluateTokenRisk(job(), goodJupiter(), goodSecurity(), policy, NOW),
    ).toEqual(result);
    expect(policyHash({ ...policy })).toBe(
      policyHash(
        Object.fromEntries(Object.entries(policy).reverse()) as typeof policy,
      ),
    );
  });
  it('reports simultaneous verified rejections before missing information', () => {
    const result = evaluateTokenRisk(
      job(),
      emptyJupiter(MINT, NOW),
      {
        ...goodSecurity(),
        mintAuthorityDisabled: false,
        freezeAuthorityDisabled: false,
      },
      policy,
      NOW,
    );
    expect(result.status).toBe('REJECTED');
    expect(result.reasons).toContain('MINT_AUTHORITY_ACTIVE');
    expect(result.reasons).toContain('FREEZE_AUTHORITY_ACTIVE');
    expect(result.reasons).toContain('JUPITER_NOT_INDEXED');
  });
  it('rejects dangerous capabilities and explicit fresh suspicious flags', () => {
    const result = evaluateTokenRisk(
      job(),
      { ...goodJupiter(), isSus: true },
      {
        ...goodSecurity(),
        supportedExtensions: false,
        extensions: [{ type: 12, name: 'PermanentDelegate', policy: 'REJECT' }],
      },
      policy,
      NOW,
    );
    expect(result.status).toBe('REJECTED');
    expect(result.reasons).toContain('PROHIBITED_PERMANENT_DELEGATE');
    expect(result.reasons).toContain('SUSPICIOUS_PROVIDER_FLAG');
  });
  it.each([
    { liquidityUsd: null },
    { topHoldersPercentage: null },
    { isSus: null },
    { updatedAt: null },
  ])(
    'never treats missing mandatory provider information as safe: %o',
    (missing) => {
      expect(
        evaluateTokenRisk(
          job(),
          { ...goodJupiter(), ...missing },
          goodSecurity(),
          policy,
          NOW,
        ).status,
      ).toBe('UNKNOWN');
    },
  );
  it('does not require redundant authority flags when RPC verifies them, but detects conflicts', () => {
    expect(
      evaluateTokenRisk(
        job(),
        {
          ...goodJupiter(),
          mintAuthorityDisabled: null,
          freezeAuthorityDisabled: null,
        },
        goodSecurity(),
        policy,
        NOW,
      ).status,
    ).toBe('ELIGIBLE');
    const conflict = evaluateTokenRisk(
      job(),
      { ...goodJupiter(), mintAuthorityDisabled: false },
      goodSecurity(),
      policy,
      NOW,
    );
    expect(conflict.status).toBe('UNKNOWN');
    expect(conflict.reasons).toContain('CONFLICTING_SOURCES');
  });
  it('declines stale security or unknown extension state', () => {
    expect(
      evaluateTokenRisk(
        job(),
        goodJupiter(),
        { ...goodSecurity(), checkedAt: '2025-12-31T23:58:00.000Z' },
        policy,
        NOW,
      ).status,
    ).toBe('UNKNOWN');
    expect(
      evaluateTokenRisk(
        job(),
        goodJupiter(),
        { ...goodSecurity(), supportedExtensions: null },
        policy,
        NOW,
      ).status,
    ).toBe('UNKNOWN');
    expect(
      evaluateTokenRisk(
        job(),
        goodJupiter(),
        { ...goodSecurity(), tokenProgram: null },
        policy,
        NOW,
      ).status,
    ).toBe('UNKNOWN');
  });
  it('uses the configured holder threshold and does not equate accounts with developers', () => {
    const metadata = {
      ...goodJupiter(),
      topHoldersPercentage: '35.000000000000000001',
    };
    expect(
      evaluateTokenRisk(job(), metadata, goodSecurity(), policy, NOW).reasons,
    ).toContain('HOLDER_CONCENTRATION_HIGH');
    expect(
      evaluateTokenRisk(
        job(),
        metadata,
        goodSecurity(),
        { ...policy, maxTopHoldersPercentage: '40' },
        NOW,
      ).status,
    ).toBe('ELIGIBLE');
  });
  it('detects deterioration from a fresh previous observation with exact comparisons', () => {
    const previous = evaluateTokenRisk(
      job(),
      { ...goodJupiter(), liquidityUsd: '100000' },
      goodSecurity(),
      policy,
      NOW,
    );
    const result = evaluateTokenRisk(
      { ...job(), previous },
      { ...goodJupiter(), liquidityUsd: '49999.999999999999999999' },
      goodSecurity(),
      policy,
      NOW,
    );
    expect(result.reasons).toContain('LIQUIDITY_DETERIORATION');
  });
});

describe('liquidity exactness and freshness', () => {
  it.each(['0', '39999.999999999999999999'])(
    'rejects verified insufficient liquidity %s',
    (liquidityUsd) => {
      expect(
        analyzeLiquidity({ ...goodJupiter(), liquidityUsd }, policy, NOW)
          .belowMinimum,
      ).toBe(true);
    },
  );
  it.each(['40000', '9007199254740993.000000000000000001', '9'.repeat(60)])(
    'compares large or boundary liquidity exactly %s',
    (liquidityUsd) => {
      expect(
        analyzeLiquidity({ ...goodJupiter(), liquidityUsd }, policy, NOW)
          .belowMinimum,
      ).toBe(false);
    },
  );
  it('marks missing, stale or future observations unknown', () => {
    expect(
      analyzeLiquidity({ ...goodJupiter(), liquidityUsd: null }, policy, NOW)
        .available,
    ).toBe(false);
    expect(
      analyzeLiquidity(goodJupiter(), policy, '2026-01-01T00:01:00.000Z')
        .available,
    ).toBe(false);
    expect(
      analyzeLiquidity(
        { ...goodJupiter(), updatedAt: '2026-01-01T00:01:00.000Z' },
        policy,
        NOW,
      ).available,
    ).toBe(false);
  });
});
