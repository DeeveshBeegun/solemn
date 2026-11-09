import { parse } from 'lossless-json';
import { z } from 'zod';
import {
  mintAddressSchema,
  positiveDecimalSchema,
  signatureSchema,
  timestampSchema,
  stableHash,
} from '@solemn/shared';

export const budgetSchema = z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  events: z.number().int().nonnegative(),
  blocked: z.boolean(),
  armed: z.boolean(),
});
export type MeteredBudget = z.infer<typeof budgetSchema>;
export const newBudget = (at: string): MeteredBudget => ({
  day: at.slice(0, 10),
  events: 0,
  blocked: false,
  armed: false,
});

export function admitMeteredMessage(
  budget: MeteredBudget,
  at: string,
  limit: number,
) {
  if (budget.blocked || !budget.armed) return false;
  const day = at.slice(0, 10);
  if (day > budget.day) {
    budget.day = day;
    budget.events = 0;
  }
  budget.events++;
  if (budget.events >= limit) budget.blocked = true;
  return true;
}

const tradeMessage = z.looseObject({ txType: z.enum(['buy', 'sell']) });
export function inspectTradeMessage(raw: string, at: string, maxBytes: number) {
  if (Buffer.byteLength(raw) > maxBytes) return null;
  let input: unknown;
  try {
    input = parse(raw, undefined, (n) => n);
  } catch {
    return null;
  }
  const parsed = tradeMessage.safeParse(input);
  if (!parsed.success) return null;
  const data = parsed.data,
    mint = mintAddressSchema.safeParse(data.mint);
  const timestamp = timestampSchema.safeParse(data.timestamp);
  const signature = signatureSchema.safeParse(data.signature);
  const trader = mintAddressSchema.safeParse(data.traderPublicKey);
  const tokenAmount = positiveDecimalSchema.safeParse(data.tokenAmount);
  const solAmount = positiveDecimalSchema.safeParse(data.solAmount);
  const pool = mintAddressSchema.safeParse(data.poolAddress);
  const eventIndex = z
    .string()
    .regex(/^\d{1,12}$/)
    .safeParse(data.eventIndex);
  const evidence = {
    mint: mint.success ? mint.data : null,
    signature: signature.success ? signature.data : null,
    side: data.txType === 'buy' ? 'BUY' : 'SELL',
    trader: trader.success ? trader.data : null,
    tokenAmount: tokenAmount.success ? tokenAmount.data : null,
    solAmount: solAmount.success ? solAmount.data : null,
    poolAddress: pool.success ? pool.data : null,
    sourceAt: timestamp.success && timestamp.data <= at ? timestamp.data : null,
    eventIndex: eventIndex.success ? eventIndex.data : null,
  };
  return {
    key: stableHash(evidence),
    evidence: {
      ...evidence,
      receivedAt: at,
      source: 'PUMPPORTAL',
      executionReadiness: 'NOT_READY',
    },
  };
}
