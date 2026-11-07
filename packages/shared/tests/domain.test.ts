import { describe, expect, it } from 'vitest';
import {
  addDecimal,
  assertOrderTransition,
  decimalSchema,
  fromAtomic,
  marketEventSchema,
  mintAddressSchema,
  multiplyDecimal,
  orderSchema,
  positiveDecimalSchema,
  tokenSchema,
  toAtomic,
  tradingSignalSchema,
} from '../src/index.js';
import {
  event,
  MINT,
  order,
  OTHER_MINT,
  signal,
  token,
} from '../../../tests/fixtures.js';

describe('domain validation', () => {
  it('validates token fields and nullable addresses', () => {
    expect(tokenSchema.parse(token)).toEqual(token);
    expect(tokenSchema.safeParse({ ...token, decimals: 256 }).success).toBe(
      false,
    );
    expect(
      tokenSchema.safeParse({ ...token, riskStatus: 'SAFE' }).success,
    ).toBe(false);
    expect(
      tokenSchema.safeParse({ ...token, createdAt: 'yesterday' }).success,
    ).toBe(false);
    expect(mintAddressSchema.safeParse('1'.repeat(44)).success).toBe(false);
    expect(mintAddressSchema.parse(MINT)).toBe(MINT);
  });
  it('validates signal and snapshot token agreement', () => {
    expect(tradingSignalSchema.parse(signal)).toEqual(signal);
    expect(
      tradingSignalSchema.safeParse({ ...signal, tokenMint: OTHER_MINT })
        .success,
    ).toBe(false);
    expect(
      tradingSignalSchema.safeParse({ ...signal, strategyVersion: '' }).success,
    ).toBe(false);
    expect(
      tradingSignalSchema.safeParse({ ...signal, riskAssessment: null })
        .success,
    ).toBe(false);
  });
  it('keeps large slots and raw event amounts exact and JSON serializable', () => {
    expect(marketEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(
      event,
    );
    expect(
      marketEventSchema.safeParse({ ...event, slot: '9223372036854775808' })
        .success,
    ).toBe(false);
    expect(
      marketEventSchema.safeParse({ ...event, sourceEventId: '' }).success,
    ).toBe(false);
  });
  it('validates order lifecycle timestamps', () => {
    expect(orderSchema.parse(order)).toEqual(order);
    expect(orderSchema.safeParse({ ...order, status: 'FILLED' }).success).toBe(
      false,
    );
  });
  it.each(['1e3', '-1', 'not-a-slot', ''])(
    'rejects malformed slots without throwing from safeParse: %s',
    (slot) => {
      expect(marketEventSchema.safeParse({ ...event, slot }).success).toBe(
        false,
      );
    },
  );
});

describe('financial precision', () => {
  it('adds decimal amounts exactly and handles values beyond Number safe integer range', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(addDecimal('9007199254740993', '0.000000000000000001')).toBe(
      '9007199254740993.000000000000000001',
    );
    expect(multiplyDecimal('0.3', '0.1')).toBe('0.03');
    expect(fromAtomic(-toAtomic('0.01'))).toBe('-0.01');
    expect(JSON.stringify({ value: fromAtomic(toAtomic('100')) })).toBe(
      '{"value":"100"}',
    );
  });
  it('rejects implicit rounding and overflow', () => {
    expect(() => multiplyDecimal('0.000000000000000001', '0.1')).toThrow(
      'rounding policy',
    );
    expect(() => addDecimal('9'.repeat(60), '1')).toThrow();
  });
  it.each([
    '-1',
    'NaN',
    'Infinity',
    '1e3',
    ' 1',
    '01',
    '.1',
    '1.',
    '0.0000000000000000001',
    '9'.repeat(61),
    '',
    0.1,
    null,
  ])('rejects invalid monetary input %s', (value) => {
    expect(decimalSchema.safeParse(value).success).toBe(false);
  });
  it('allows zero amounts but rejects zero quantities', () => {
    expect(decimalSchema.parse('0')).toBe('0');
    expect(positiveDecimalSchema.safeParse('0.000').success).toBe(false);
  });
});

describe('order state transitions', () => {
  it.each([
    ['CREATED', 'SUBMITTED'],
    ['SUBMITTED', 'PARTIALLY_FILLED'],
    ['PARTIALLY_FILLED', 'FILLED'],
    ['SUBMITTED', 'CANCELLED'],
    ['CREATED', 'FAILED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => assertOrderTransition(from, to)).not.toThrow();
  });
  it.each([
    ['CREATED', 'FILLED'],
    ['FILLED', 'CANCELLED'],
    ['FAILED', 'SUBMITTED'],
    ['CANCELLED', 'FILLED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => assertOrderTransition(from, to)).toThrow(
      'Invalid order transition',
    );
  });
});
