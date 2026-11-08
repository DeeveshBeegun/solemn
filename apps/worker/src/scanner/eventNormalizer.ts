import { createHash } from 'node:crypto';
import { parse } from 'lossless-json';
import { z } from 'zod';
import {
  mintAddressSchema,
  scannerEventSchema,
  signatureSchema,
  timestampSchema,
} from '@solemn/shared';
import type { ScannerEvent } from '@solemn/shared';

export type Subscription = 'subscribeNewToken' | 'subscribeMigration';
export type ParsedMessage =
  | { kind: 'event'; value: ScannerEvent }
  | { kind: 'ack'; subscription: Subscription }
  | { kind: 'providerError'; authentication: boolean }
  | {
      kind: 'rejected';
      reason:
        | 'INVALID_JSON'
        | 'INVALID_EVENT'
        | 'UNKNOWN_MESSAGE'
        | 'MESSAGE_TOO_LARGE';
    };

const optionalAddress = mintAddressSchema.nullable().optional();
const providerEvent = z.looseObject({
  txType: z.enum(['create', 'migrate']),
  mint: mintAddressSchema,
  signature: signatureSchema.nullable().optional(),
  name: z.string().trim().max(256).nullable().optional(),
  symbol: z.string().trim().max(256).nullable().optional(),
  slot: z
    .string()
    .regex(/^(0|[1-9]\d{0,18})$/)
    .refine(
      (value) =>
        /^(0|[1-9]\d{0,18})$/.test(value) &&
        BigInt(value) <= 9223372036854775807n,
    )
    .nullable()
    .optional(),
  eventIndex: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  decimals: z
    .string()
    .regex(/^\d{1,3}$/)
    .refine((value) => Number(value) <= 255)
    .nullable()
    .optional(),
  creator: optionalAddress,
  creatorPublicKey: optionalAddress,
  bondingCurveKey: optionalAddress,
  poolAddress: optionalAddress,
  pool: z.string().trim().min(1).max(256).nullable().optional(),
});

function deterministicId(hash: string): string {
  const bytes = Buffer.from(hash.slice(0, 32), 'hex');
  bytes[6] = ((bytes[6] ?? 0) & 15) | 128; // RFC 9562 UUIDv8, custom SHA-256 identity.
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeMessage(
  rawMessage: string,
  receivedAt: string,
  maxBytes = 65536,
): ParsedMessage {
  if (Buffer.byteLength(rawMessage) > maxBytes)
    return { kind: 'rejected', reason: 'MESSAGE_TOO_LARGE' };
  let payload: unknown;
  try {
    // Keep numeric lexemes as strings in the adapter; never round a large slot or amount.
    // Persistence separately parses rawMessage as PostgreSQL JSONB, preserving original JSON types.
    payload = parse(rawMessage, undefined, (value) => value);
  } catch {
    return { kind: 'rejected', reason: 'INVALID_JSON' };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return { kind: 'rejected', reason: 'UNKNOWN_MESSAGE' };
  const object = payload as Record<string, unknown>;
  if (
    typeof object.error === 'string' ||
    (typeof object.message === 'string' &&
      /error|invalid|unauthori[sz]ed|forbidden/i.test(object.message))
  ) {
    const message = String(object.error ?? object.message);
    return {
      kind: 'providerError',
      authentication: /api.?key|auth|forbidden|401|403/i.test(message),
    };
  }
  if (object.txType === undefined && typeof object.message === 'string') {
    if (object.message === 'Successfully subscribed to token creation events.')
      return { kind: 'ack', subscription: 'subscribeNewToken' };
    if (object.message === "Subscribed to 'migration' events.")
      return { kind: 'ack', subscription: 'subscribeMigration' };
  }
  if (object.txType !== 'create' && object.txType !== 'migrate')
    return { kind: 'rejected', reason: 'UNKNOWN_MESSAGE' };
  const result = providerEvent.safeParse(payload);
  if (!result.success) return { kind: 'rejected', reason: 'INVALID_EVENT' };
  const data = result.data;
  const migration = data.txType === 'migrate';
  const eventType = migration ? 'TOKEN_MIGRATED' : 'TOKEN_CREATED';
  // No timestamp units are guessed: only explicit UTC ISO strings are recognized.
  const sourceTime = timestampSchema.safeParse(data.timestamp);
  const occurredAt = sourceTime.success ? sourceTime.data : null;
  const signature = data.signature ?? null;
  const identity = signature
    ? JSON.stringify([
        'PUMPPORTAL',
        eventType,
        data.mint,
        signature,
        data.eventIndex ?? null,
        data.poolAddress ?? null,
        migration ? (data.pool ?? null) : null,
      ])
    : rawMessage;
  const hash = createHash('sha256').update(identity).digest('hex');
  try {
    const value = scannerEventSchema.parse({
      event: {
        id: deterministicId(hash),
        tokenMint: data.mint,
        eventType,
        source: 'PUMPPORTAL',
        sourceEventId: `sha256:${hash}`,
        slot: data.slot ?? null,
        transactionSignature: signature,
        eventAt: occurredAt,
        ingestedAt: receivedAt,
        rawPayload: payload,
        rawMessage,
      },
      token: {
        mintAddress: data.mint,
        name: data.name || null,
        symbol: data.symbol || null,
        decimals: data.decimals == null ? null : Number(data.decimals),
        createdAt: migration ? null : occurredAt,
        discoveredAt: receivedAt,
        sourcePlatform: 'PUMPPORTAL',
        riskStatus: 'UNKNOWN',
        poolAddress: data.poolAddress ?? null,
        // traderPublicKey describes a trader, not a guaranteed creator identity.
        creatorAddress: data.creatorPublicKey ?? data.creator ?? null,
        bondingCurveAddress: data.bondingCurveKey ?? null,
        migrationStatus: migration ? 'MIGRATED' : 'UNKNOWN',
        migratedAt: migration ? occurredAt : null,
        migrationObservedAt: migration ? receivedAt : null,
        migrationVenue: migration ? (data.pool ?? null) : null,
      },
    });
    return { kind: 'event', value };
  } catch {
    return { kind: 'rejected', reason: 'INVALID_EVENT' };
  }
}
