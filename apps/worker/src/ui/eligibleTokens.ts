import { sql } from 'drizzle-orm';
import { eligibleRiskConditions } from '@solemn/database';
import type { Database } from '@solemn/database';
import { loadConfig } from '../config/index.js';
import { policyHash, riskPolicy } from '../risk/tokenRiskEngine.js';
import { readDatabase } from './dataExplorer.js';

type EligibleToken = {
  mint: string;
  name: string | null;
  symbol: string | null;
  source: string;
  assessmentId: string;
  assessedAt: string;
  validUntil: string;
  liquidityUsd: string | null;
  total: string;
};
export async function queryEligibleTokens(
  db: Database,
  hash: string,
  now: string,
) {
  const result = await db.execute<EligibleToken>(sql`
    SELECT tokens.mint_address AS mint,tokens.name,tokens.symbol,tokens.source_platform AS source,
      token_risk_assessments.id::text AS "assessmentId",token_risk_assessments.assessed_at AS "assessedAt",
      least(tokens.risk_valid_until,token_risk_assessments.valid_until) AS "validUntil",
      token_risk_assessments.checks->>'liquidityUsd' AS "liquidityUsd",count(*) OVER()::text AS total
    FROM tokens JOIN token_risk_assessments ON token_risk_assessments.id=tokens.latest_risk_assessment_id
    WHERE ${eligibleRiskConditions(now, hash)}
      AND lower(tokens.source_platform) !~ '(fixture|synthetic|replay|^test($|_))'
      AND coalesce(tokens.risk_trigger,'')<>'FIXTURE'
    ORDER BY token_risk_assessments.assessed_at DESC,tokens.mint_address LIMIT 201
  `);
  return {
    checkedAt: now,
    total: Number(result.rows[0]?.total ?? 0),
    truncated: result.rows.length > 200,
    tokens: result.rows.slice(0, 200).map(({ total, ...token }) => {
      void total;
      return {
        ...token,
        assessedAt: new Date(token.assessedAt).toISOString(),
        validUntil: new Date(token.validUntil).toISOString(),
      };
    }),
  };
}

export async function readEligibleTokens() {
  const config = loadConfig(process.env);
  return readDatabase(async (db) => ({
    ...(await queryEligibleTokens(
      db,
      policyHash(riskPolicy(config)),
      new Date().toISOString(),
    )),
    riskAnalysisConfigured: config.TOKEN_RISK_ANALYSIS_ENABLED,
  }));
}
