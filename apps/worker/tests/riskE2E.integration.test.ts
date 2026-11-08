import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pino from 'pino';
import { eq, inArray, sql } from 'drizzle-orm';
import { getAddressDecoder } from '@solana/kit';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createRiskRepository,
  createScannerRepository,
  marketEvents,
  migrateDatabase,
  scannerGaps,
  tokenRiskAssessments,
  tokens,
} from '@solemn/database';
import type { RiskJob, ScannerGap } from '@solemn/shared';
import { loadConfig } from '../src/config/index.js';
import { createRiskAnalysisService } from '../src/analysis/riskAnalysisService.js';
import { JupiterTokenClient } from '../src/analysis/jupiterTokenClient.js';
import { TokenSecurityClient } from '../src/analysis/tokenSecurity.js';
import { createScannerService } from '../src/scanner/scannerService.js';
import { creationAck, migrationAck } from './scannerFixtures.js';
import { jupiterPayload, mintAccount } from './riskFixtures.js';

config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const database = createDatabase(
  assertSafeTestDatabase(
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
  ),
);
beforeAll(async () => {
  await migrateDatabase(database.db);
});
afterAll(async () => {
  await database.close();
});

it('screens mock discoveries end-to-end, deduplicates jobs, and reassesses a migration without trades', async () => {
  const mints = [81, 82, 83].map((value) =>
    String(getAddressDecoder().decode(new Uint8Array(32).fill(value))),
  );
  const first = mints[0] as string,
    dangerous = mints[1] as string,
    missing = mints[2] as string;
  // This test needs independent concurrent pool transactions. Refuse existing fixture
  // keys, then clean up only the rows owned by this test in the guarded test database.
  expect(
    await database.db
      .select()
      .from(tokens)
      .where(inArray(tokens.mintAddress, mints)),
  ).toHaveLength(0);
  const gapIds = new Set<string>();
  const now = () => Date.now() + 1000;
  const logger = pino({ level: 'silent' });
  const sourceCalls: string[] = [];
  let migrated = false;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const location = server.address();
  if (!location || typeof location === 'string')
    throw new Error('Missing mock port');
  let socket: WebSocket | undefined;
  const subscribed = new Set<string>();
  server.on('connection', (connection) => {
    socket = connection;
    connection.on('message', (data) => {
      const method = (JSON.parse(data.toString()) as { method: string }).method;
      subscribed.add(method);
      if (method === 'subscribeNewToken') connection.send(creationAck);
      if (method === 'subscribeMigration') connection.send(migrationAck);
    });
  });
  const settings = loadConfig({
    DATABASE_URL: 'postgresql://localhost/solemn',
    TOKEN_RISK_ANALYSIS_ENABLED: 'true',
    SCANNER_ENABLED: 'true',
    PUMPPORTAL_WS_URL: `ws://127.0.0.1:${location.port}`,
    JUPITER_TOKENS_BASE_URL: 'http://127.0.0.1:1234/tokens/v2',
    JUPITER_REQUEST_INTERVAL_MS: '1',
    SOLANA_RPC_URL: 'http://127.0.0.1:1234',
    RISK_RPC_REQUEST_INTERVAL_MS: '1',
    RISK_ANALYSIS_RETRY_LIMIT: '1',
    RISK_POLL_INTERVAL_MS: '10',
    RISK_HTTP_MAX_ATTEMPTS: '1',
  });
  const mockFetch: typeof fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        method: string;
        params: [string[]];
      };
      sourceCalls.push(body.method);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'solemn-risk',
          result: {
            context: { slot: 123 },
            value: body.params[0].map((mint) =>
              mintAccount({ mintActive: mint === dangerous }),
            ),
          },
        }),
      );
    }
    sourceCalls.push('JUPITER_SEARCH');
    const requested =
      new URL(String(url)).searchParams.get('query')?.split(',') ?? [];
    return new Response(
      JSON.stringify(
        requested.map((mint) => ({
          ...jupiterPayload(mint, new Date(now()).toISOString()),
          liquidity:
            mint === missing ? null : mint === first && migrated ? 0 : 50000,
        })),
      ),
    );
  };
  const base = createRiskRepository(database.db);
  const scoped = {
    ...base,
    expire: async () => undefined,
    async claim(limit: number, time: string, lease: number, attempts: number) {
      const jobs: RiskJob[] = [];
      for (const mint of mints) {
        if (jobs.length >= limit) break;
        jobs.push(
          ...(await base.claim(
            limit - jobs.length,
            time,
            lease,
            attempts,
            mint,
          )),
        );
      }
      return jobs;
    },
  };
  const risk = createRiskAnalysisService(settings, scoped, logger, {
    jupiter: new JupiterTokenClient(settings, mockFetch, undefined, now),
    security: new TokenSecurityClient(settings, mockFetch, undefined, now),
    now,
  });
  const scannerBase = createScannerRepository(database.db, {
    requestRiskAnalysis: true,
  });
  const scanner = createScannerService(
    settings,
    {
      ...scannerBase,
      async recordGap(gap: ScannerGap) {
        gapIds.add(gap.id);
        await scannerBase.recordGap(gap);
      },
    },
    logger,
    undefined,
    (event) =>
      risk.notify(
        event.event.tokenMint,
        event.event.eventType === 'TOKEN_MIGRATED',
      ),
  );
  try {
    const before = await database.db.execute(
      sql`SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM trades) AS trades`,
    );
    await risk.start();
    await scanner.start();
    await vi.waitFor(() => expect(subscribed.size).toBe(2));
    const launch = (mint: string) =>
      JSON.stringify({ txType: 'create', mint, signature: '1'.repeat(64) });
    for (const mint of mints) socket?.send(launch(mint));
    socket?.send(launch(first));
    await vi.waitFor(
      async () => {
        const rows = await database.db
          .select()
          .from(tokenRiskAssessments)
          .where(inArray(tokenRiskAssessments.tokenMint, mints));
        expect(rows).toHaveLength(3);
        expect(rows.find((row) => row.tokenMint === first)?.status).toBe(
          'ELIGIBLE',
        );
        expect(rows.find((row) => row.tokenMint === dangerous)?.status).toBe(
          'REJECTED',
        );
        expect(
          rows.find((row) => row.tokenMint === dangerous)?.reasons,
        ).toContain('MINT_AUTHORITY_ACTIVE');
        expect(rows.find((row) => row.tokenMint === missing)?.status).toBe(
          'UNKNOWN',
        );
      },
      { timeout: 10000 },
    );
    expect(scanner.metrics().duplicateEvents).toBe(1);
    const original = (
      await database.db
        .select()
        .from(tokens)
        .where(eq(tokens.mintAddress, first))
    )[0];
    expect(original?.riskStatus).toBe('ELIGIBLE');
    migrated = true;
    socket?.send(
      JSON.stringify({
        txType: 'migrate',
        mint: first,
        signature: '1'.repeat(64),
        pool: 'pump-amm',
      }),
    );
    await vi.waitFor(
      async () => {
        const row = (
          await database.db
            .select()
            .from(tokens)
            .where(eq(tokens.mintAddress, first))
        )[0];
        expect(row?.riskStatus).toBe('REJECTED');
        const history = await database.db
          .select()
          .from(tokenRiskAssessments)
          .where(eq(tokenRiskAssessments.tokenMint, first));
        expect(history).toHaveLength(2);
        expect(history.some((item) => item.status === 'ELIGIBLE')).toBe(true);
      },
      { timeout: 10000 },
    );
    expect(
      sourceCalls.every((method) =>
        ['JUPITER_SEARCH', 'getMultipleAccounts'].includes(method),
      ),
    ).toBe(true);
    expect(
      (
        await database.db.execute(
          sql`SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM trades) AS trades`,
        )
      ).rows,
    ).toEqual(before.rows);
  } finally {
    try {
      await scanner.stop();
    } finally {
      await risk.stop();
    }
    for (const connection of server.clients) connection.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.db.transaction(async (tx) => {
      await tx
        .update(tokens)
        .set({ latestRiskAssessmentId: null })
        .where(inArray(tokens.mintAddress, mints));
      await tx
        .delete(tokenRiskAssessments)
        .where(inArray(tokenRiskAssessments.tokenMint, mints));
      await tx
        .delete(marketEvents)
        .where(inArray(marketEvents.tokenMint, mints));
      await tx.delete(tokens).where(inArray(tokens.mintAddress, mints));
      if (gapIds.size)
        await tx
          .delete(scannerGaps)
          .where(inArray(scannerGaps.id, [...gapIds]));
    });
  }
});
