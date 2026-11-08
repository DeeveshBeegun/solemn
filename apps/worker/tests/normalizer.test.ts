import { describe, expect, it } from 'vitest';
import { normalizeMessage } from '../src/scanner/eventNormalizer.js';
import {
  creationAck,
  launch,
  launchRaw,
  LATER,
  migrationAck,
  migrationRaw,
  observedMigration,
  NOW,
} from './scannerFixtures.js';

describe('PumpPortal normalization', () => {
  it('accepts the observed minimal migration without fabricating its destination', () => {
    const parsed = normalizeMessage(JSON.stringify(observedMigration), NOW);
    if (parsed.kind !== 'event') throw new Error('Expected migration');
    expect(parsed.value.token.poolAddress).toBeNull();
    expect(parsed.value.token.name).toBeNull();
    expect(parsed.value.token.createdAt).toBeNull();
    expect(parsed.value.token.migrationVenue).toBe('pump-amm');
  });
  it('normalizes creation, preserving unknown fields and unknown metadata', () => {
    const result = normalizeMessage(launchRaw, NOW);
    expect(result.kind).toBe('event');
    if (result.kind !== 'event') throw new Error('Expected event');
    expect(result.value.event.eventType).toBe('TOKEN_CREATED');
    expect(result.value.event.eventAt).toBeNull();
    expect(result.value.token.createdAt).toBeNull();
    expect(result.value.token.decimals).toBeNull();
    expect(result.value.token.creatorAddress).toBeNull(); // A trader is not a proven creator.
    expect(result.value.token.bondingCurveAddress).toBe(launch.bondingCurveKey);
    expect(result.value.event.rawMessage).toBe(launchRaw);
    expect(result.value.event.rawPayload.additionalProviderField).toEqual({
      preserved: true,
    });
    expect(result.value.token.riskStatus).toBe('UNKNOWN');
  });
  it('normalizes migration without inventing creation metadata', () => {
    const result = normalizeMessage(migrationRaw, NOW);
    if (result.kind !== 'event') throw new Error('Expected event');
    expect(result.value.event.eventType).toBe('TOKEN_MIGRATED');
    expect(result.value.token.migrationStatus).toBe('MIGRATED');
    expect(result.value.token.migrationObservedAt).toBe(NOW);
    expect(result.value.token.migratedAt).toBeNull();
    expect(result.value.token.name).toBeNull();
  });
  it('separates source time from receipt and handles exact large slots', () => {
    const raw = JSON.stringify({ ...launch, timestamp: NOW }).replace(
      /}$/,
      ',"slot":9007199254740993,"decimals":9}',
    );
    const result = normalizeMessage(raw, LATER);
    if (result.kind !== 'event') throw new Error('Expected event');
    expect(result.value.event.slot).toBe('9007199254740993');
    expect(result.value.event.eventAt).toBe(NOW);
    expect(result.value.token.discoveredAt).toBe(LATER);
    expect(result.value.token.decimals).toBe(9);
  });
  it('does not guess units for numeric source timestamps', () => {
    const result = normalizeMessage(
      JSON.stringify({ ...launch, timestamp: 1700000000 }),
      NOW,
    );
    if (result.kind !== 'event') throw new Error('Expected event');
    expect(result.value.event.eventAt).toBeNull();
  });
  it('deduplicates independently of receipt time and JSON key ordering when signed', () => {
    const a = normalizeMessage(launchRaw, NOW);
    const b = normalizeMessage(
      JSON.stringify(Object.fromEntries(Object.entries(launch).reverse())),
      LATER,
    );
    if (a.kind !== 'event' || b.kind !== 'event')
      throw new Error('Expected events');
    expect(a.value.event.id).toBe(b.value.event.id);
    const migrated = normalizeMessage(migrationRaw, NOW);
    if (migrated.kind !== 'event') throw new Error('Expected migration');
    expect(a.value.event.id).not.toBe(migrated.value.event.id);
    const indexed = normalizeMessage(
      JSON.stringify({ ...launch, eventIndex: 1 }),
      NOW,
    );
    if (indexed.kind !== 'event') throw new Error('Expected indexed event');
    expect(a.value.event.id).not.toBe(indexed.value.event.id);
  });
  it('uses an exact raw message digest without a reliable signature', () => {
    const unsigned = JSON.stringify({ ...launch, signature: null });
    const a = normalizeMessage(unsigned, NOW);
    const b = normalizeMessage(unsigned, LATER);
    if (a.kind !== 'event' || b.kind !== 'event')
      throw new Error('Expected events');
    expect(a.value.event.id).toBe(b.value.event.id);
  });
  it.each([
    '{',
    'null',
    '[]',
    '{"txType":"buy"}',
    '{"txType":"create"}',
    JSON.stringify({ ...launch, mint: 'invalid' }),
    JSON.stringify({ ...launch, slot: 'not-a-slot' }),
  ])('rejects malformed or unsupported payload %s', (raw) => {
    expect(normalizeMessage(raw, NOW).kind).toBe('rejected');
  });
  it('rejects oversized messages', () => {
    expect(normalizeMessage(launchRaw, NOW, 10)).toEqual({
      kind: 'rejected',
      reason: 'MESSAGE_TOO_LARGE',
    });
  });
  it('recognizes only verified acknowledgements and sanitizes provider errors', () => {
    expect(normalizeMessage(creationAck, NOW)).toEqual({
      kind: 'ack',
      subscription: 'subscribeNewToken',
    });
    expect(normalizeMessage(migrationAck, NOW)).toEqual({
      kind: 'ack',
      subscription: 'subscribeMigration',
    });
    expect(normalizeMessage('{"error":"Invalid API key SECRET"}', NOW)).toEqual(
      { kind: 'providerError', authentication: true },
    );
    expect(normalizeMessage('{"message":"hello"}', NOW).kind).toBe('rejected');
  });
});
