import { describe, expect, it } from 'vitest';
import {
  inspectMint,
  TokenSecurityClient,
} from '../src/analysis/tokenSecurity.js';
import { loadConfig } from '../src/config/index.js';
import {
  mintAccount,
  MINT,
  NOW,
  OTHER_MINT,
  TOKEN_2022_PROGRAM,
} from './riskFixtures.js';

describe('official SPL mint security decoding', () => {
  it.each([
    [{}, true, true],
    [{ mintActive: true }, false, true],
    [{ freezeActive: true }, true, false],
  ] as const)(
    'checks actual mint/freeze options and exact base-unit supply %o',
    (options, mintDisabled, freezeDisabled) => {
      const result = inspectMint(
        MINT,
        mintAccount(options),
        NOW,
        '9007199254740993',
      );
      expect(result.validMint).toBe(true);
      expect(result.mintAuthorityDisabled).toBe(mintDisabled);
      expect(result.freezeAuthorityDisabled).toBe(freezeDisabled);
      expect(result.supplyBaseUnits).toBe('9007199254740993');
    },
  );
  it('distinguishes missing, unsupported owner and invalid mint accounts', () => {
    expect(inspectMint(MINT, null, NOW, '1').mintAuthorityDisabled).toBeNull();
    expect(
      inspectMint(MINT, mintAccount({ owner: OTHER_MINT }), NOW, '1').issues,
    ).toContain('UNSUPPORTED_TOKEN_PROGRAM');
    const invalid = mintAccount();
    invalid.data[0] = Buffer.alloc(10).toString('base64');
    expect(inspectMint(MINT, invalid, NOW, '1').validMint).toBe(false);
  });
  it('supports bare Token-2022 and the metadata-pointer allowlist', () => {
    expect(
      inspectMint(MINT, mintAccount({ owner: TOKEN_2022_PROGRAM }), NOW, '1')
        .supportedExtensions,
    ).toBe(true);
    const result = inspectMint(
      MINT,
      mintAccount({
        owner: TOKEN_2022_PROGRAM,
        extensions: [{ type: 18, length: 64 }],
      }),
      NOW,
      '1',
    );
    expect(result.supportedExtensions).toBe(true);
    expect(result.extensions[0]?.name).toBe('MetadataPointer');
  });
  it.each([
    [12, 32, 'PermanentDelegate'],
    [14, 64, 'TransferHook'],
    [1, 108, 'TransferFeeConfig'],
    [9, 0, 'NonTransferable'],
    [6, 1, 'DefaultAccountState'],
    [26, 33, 'PausableConfig'],
  ] as const)(
    'excludes capability %s with an explicit policy',
    (type, length, name) => {
      const result = inspectMint(
        MINT,
        mintAccount({
          owner: TOKEN_2022_PROGRAM,
          extensions: [{ type, length }],
        }),
        NOW,
        '1',
      );
      expect(result.supportedExtensions).toBe(false);
      expect(result.extensions).toContainEqual({
        type,
        name,
        policy: 'REJECT',
      });
    },
  );
  it('does not pass an unknown extension or malformed TLV payload', () => {
    const unknown = inspectMint(
      MINT,
      mintAccount({
        owner: TOKEN_2022_PROGRAM,
        extensions: [{ type: 65000, length: 2 }],
      }),
      NOW,
      '1',
    );
    expect(unknown.supportedExtensions).toBeNull();
    const invalid = mintAccount({
      owner: TOKEN_2022_PROGRAM,
      extensions: [{ type: 12, length: 31 }],
    });
    const result = inspectMint(MINT, invalid, NOW, '1');
    expect(result.supportedExtensions).toBeNull();
    expect(result.mintAuthorityDisabled).toBeNull();
  });
  it('batches read-only RPC requests and fails closed on RPC errors', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/solemn',
      SOLANA_RPC_URL: 'http://127.0.0.1:1234',
      RISK_RPC_REQUEST_INTERVAL_MS: '1',
      RISK_HTTP_MAX_ATTEMPTS: '1',
    });
    let method = '';
    const client = new TokenSecurityClient(config, async (_url, init) => {
      method = (JSON.parse(String(init?.body)) as { method: string }).method;
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'solemn-risk',
          result: {
            context: { slot: 123 },
            value: [mintAccount(), mintAccount({ mintActive: true })],
          },
        }),
      );
    });
    const results = await client.getMany(
      [MINT, OTHER_MINT],
      new AbortController().signal,
    );
    expect(method).toBe('getMultipleAccounts');
    expect(results.get(MINT)?.mintAuthorityDisabled).toBe(true);
    expect(results.get(OTHER_MINT)?.mintAuthorityDisabled).toBe(false);
    const failing = new TokenSecurityClient(config, async () => {
      throw new Error('private RPC credential must not leak');
    });
    const failed = (
      await failing.getMany([MINT], new AbortController().signal)
    ).get(MINT);
    expect(failed?.state).toBe('ERROR');
    expect(failed?.mintAuthorityDisabled).toBeNull();
    expect(JSON.stringify(failed)).not.toContain('credential');
  });
  it('rejects trade endpoints and leaves timed-out mint evidence unknown', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/solemn',
      SOLANA_RPC_URL: 'http://127.0.0.1:1234',
      RISK_HTTP_TIMEOUT_MS: '10',
      RISK_HTTP_MAX_ATTEMPTS: '1',
    });
    for (const url of [
      'https://api.jup.ag/swap/v2/execute',
      'https://pumpportal.fun/api/trade',
    ])
      expect(
        () => new TokenSecurityClient({ ...config, SOLANA_RPC_URL: url }),
      ).toThrow('read-only RPC');
    const client = new TokenSecurityClient(
      config,
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('Expected RPC timeout signal');
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    expect(
      (await client.getMany([MINT], new AbortController().signal)).get(MINT),
    ).toMatchObject({
      state: 'ERROR',
      validMint: null,
      error: { code: 'TIMEOUT' },
    });
  });
});
