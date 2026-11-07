import { describe, expect, it } from 'vitest';
import { assertSafeTestDatabase } from '../src/test-safety.js';

const safe =
  'postgresql://solemn_test:test_password@localhost:5433/solemn_test';
describe('integration database safety', () => {
  it('accepts only a dedicated local test target', () => {
    expect(
      assertSafeTestDatabase(
        safe,
        'postgresql://solemn:password@localhost:5432/solemn',
      ),
    ).toBe(safe);
  });
  it.each([
    undefined,
    'not-a-url',
    'postgresql://solemn_test:password@remote.example/solemn_test',
    'postgresql://solemn_test:password@localhost/solemn',
    'postgresql://solemn:password@localhost/solemn_test',
    `${safe}?host=remote.example`,
    `${safe}#fragment`,
  ])('refuses unsafe target %s before connecting', (url) => {
    expect(() => assertSafeTestDatabase(url)).toThrow();
  });
  it('refuses a development target on the same database and port', () => {
    expect(() =>
      assertSafeTestDatabase(
        safe,
        safe.replace('solemn_test:test_password', 'another:password'),
      ),
    ).toThrow('distinct');
  });
});
