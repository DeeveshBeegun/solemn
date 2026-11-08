import { z } from 'zod';
import {
  decimalSchema,
  idSchema,
  mintAddressSchema,
  riskStatusSchema,
  timestampSchema,
} from './schemas/index.js';

export const percentageSchema = decimalSchema.refine((value) => {
  if (!decimalSchema.safeParse(value).success) return false;
  const [whole = '0', fraction = ''] = value.split('.');
  return (
    BigInt(whole) < 100n || (BigInt(whole) === 100n && !/[1-9]/.test(fraction))
  );
}, 'Expected a percentage from 0 to 100');

export const riskPolicySchema = z.strictObject({
  version: z.string().min(1).max(100),
  minLiquidityUsd: decimalSchema,
  maxTopHoldersPercentage: percentageSchema,
  maxLiquidityDropPercentage: percentageSchema,
  maxDataAgeSeconds: z.number().int().positive(),
  requireHolderData: z.boolean(),
  requireExplicitSuspiciousFlag: z.boolean(),
});
export type RiskPolicy = z.infer<typeof riskPolicySchema>;

export const providerErrorSchema = z.strictObject({
  code: z.enum([
    'TIMEOUT',
    'ABORTED',
    'NETWORK',
    'HTTP_ERROR',
    'RATE_LIMITED',
    'AUTHENTICATION',
    'INVALID_RESPONSE',
    'MINT_MISMATCH',
    'CLIENT_BUSY',
    'RPC_ERROR',
  ]),
  httpStatus: z.number().int().nullable(),
  retryAt: timestampSchema.nullable(),
});
const sourceState = z.enum(['OK', 'MISSING', 'ERROR']);

export const jupiterObservationSchema = z.strictObject({
  source: z.literal('JUPITER_V2'),
  mint: mintAddressSchema,
  state: sourceState,
  fetchedAt: timestampSchema,
  updatedAt: timestampSchema.nullable(),
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
  tokenProgram: mintAddressSchema.nullable(),
  usdPrice: decimalSchema.nullable(),
  liquidityUsd: decimalSchema.nullable(),
  marketCapUsd: decimalSchema.nullable(),
  activity: z.record(z.string(), z.json()).nullable(),
  holderCount: z
    .string()
    .regex(/^\d{1,30}$/)
    .nullable(),
  isVerified: z.boolean().nullable(),
  organicScore: percentageSchema.nullable(),
  mintAuthorityDisabled: z.boolean().nullable(),
  freezeAuthorityDisabled: z.boolean().nullable(),
  topHoldersPercentage: percentageSchema.nullable(),
  isSus: z.boolean().nullable(),
  issues: z.array(z.string()),
  rawResponse: z.string().max(2097152).nullable(),
  error: providerErrorSchema.nullable(),
});
export type JupiterObservation = z.infer<typeof jupiterObservationSchema>;

export const mintSecuritySchema = z.strictObject({
  source: z.literal('SOLANA_RPC'),
  mint: mintAddressSchema,
  state: sourceState,
  checkedAt: timestampSchema,
  contextSlot: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable(),
  commitment: z.literal('confirmed'),
  tokenProgram: mintAddressSchema.nullable(),
  validMint: z.boolean().nullable(),
  mintAuthorityDisabled: z.boolean().nullable(),
  freezeAuthorityDisabled: z.boolean().nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
  supplyBaseUnits: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable(),
  supportedExtensions: z.boolean().nullable(),
  extensions: z.array(
    z.strictObject({
      type: z.number().int(),
      name: z.string(),
      policy: z.enum(['ALLOW', 'REJECT', 'UNKNOWN']),
    }),
  ),
  issues: z.array(z.string()),
  accountDataBase64: z.string().max(1048576).nullable(),
  error: providerErrorSchema.nullable(),
});
export type MintSecurity = z.infer<typeof mintSecuritySchema>;
export type ProviderErrorData = z.infer<typeof providerErrorSchema>;

export const riskChecksSchema = z.strictObject({
  tokenProgram: mintAddressSchema.nullable(),
  mintAuthorityDisabled: z.boolean().nullable(),
  freezeAuthorityDisabled: z.boolean().nullable(),
  supportedExtensions: z.boolean().nullable(),
  liquidityUsd: decimalSchema.nullable(),
  liquidityFresh: z.boolean(),
  topHoldersPercentage: percentageSchema.nullable(),
  suspiciousProviderFlag: z.boolean().nullable(),
  liquidityDeteriorated: z.boolean().nullable(),
  previousLiquidityUsd: decimalSchema.nullable(),
});

export const tokenRiskAssessmentSchema = z
  .strictObject({
    id: idSchema,
    tokenMint: mintAddressSchema,
    requestId: idSchema,
    attempt: z.number().int().positive(),
    requestedAt: timestampSchema,
    status: riskStatusSchema,
    reasons: z.array(z.string().regex(/^[A-Z0-9_]+$/)).min(1),
    checks: riskChecksSchema,
    policy: riskPolicySchema,
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    assessedAt: timestampSchema,
    validUntil: timestampSchema.nullable(),
    evidence: z.strictObject({
      jupiter: jupiterObservationSchema,
      solana: mintSecuritySchema,
      previousAssessmentId: idSchema.nullable(),
    }),
  })
  .refine(
    (value) =>
      value.tokenMint === value.evidence.jupiter.mint &&
      value.tokenMint === value.evidence.solana.mint,
    'Assessment evidence mint mismatch',
  )
  .refine(
    (value) =>
      value.status !== 'ELIGIBLE' ||
      (value.validUntil !== null &&
        Date.parse(value.validUntil) > Date.parse(value.assessedAt)),
    'Eligibility must have a future expiry',
  );

export type TokenRiskAssessment = z.infer<typeof tokenRiskAssessmentSchema>;
export interface RiskJob {
  tokenMint: string;
  requestId: string;
  requestedAt: string;
  attempt: number;
  trigger: string;
  previous: TokenRiskAssessment | null;
}
