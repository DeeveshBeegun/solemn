/** Run before opening a connection or applying migrations. No destructive cleanup is used. */
export function assertSafeTestDatabase(
  testUrl: string | undefined,
  developmentUrl?: string,
): string {
  if (!testUrl)
    throw new Error(
      'TEST_DATABASE_URL is required; use the dedicated solemn_test database',
    );
  let parsed: URL;
  try {
    parsed = new URL(testUrl);
  } catch {
    throw new Error('Invalid TEST_DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.pathname !== '/solemn_test' ||
    parsed.username !== 'solemn_test' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'Integration tests require a local solemn_test database and solemn_test user, without URL parameters',
    );
  }
  if (developmentUrl) {
    const development = new URL(developmentUrl);
    if (
      development.pathname === parsed.pathname &&
      (development.port || '5432') === (parsed.port || '5432')
    ) {
      throw new Error('Test database must be distinct from DATABASE_URL');
    }
  }
  return testUrl;
}
