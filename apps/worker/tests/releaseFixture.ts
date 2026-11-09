import { eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import {
  createRiskRepository,
  createScannerRepository,
  marketEvents,
  tokens,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import type { HistoricalEvent } from '@solemn/shared';
import type { Logger } from 'pino';
import { JupiterTokenClient } from '../src/analysis/jupiterTokenClient.js';
import { TokenSecurityClient } from '../src/analysis/tokenSecurity.js';
import type { Config } from '../src/config/index.js';
import {
  createForwardReplayFixture,
  createReplayProvider,
} from '../src/forward/replayProvider.js';
import { evaluateTokenRisk, riskPolicy } from '../src/risk/tokenRiskEngine.js';
import { createScannerService } from '../src/scanner/scannerService.js';
import type { TransportFactory } from '../src/scanner/pumpPortalClient.js';
import { jupiterPayload, mintAccount } from './riskFixtures.js';
import { creationAck, migrationAck } from './scannerFixtures.js';

export async function releaseTape(
  db: Database,
  config: Config,
  logger: Logger,
) {
  const source = createForwardReplayFixture(config);
  const market = source.manifest.markets[0]!;
  const at = source.manifest.startTime;
  const factory: TransportFactory = (_url, handlers) => {
    queueMicrotask(() => handlers.open());
    return {
      send(value) {
        const method = (JSON.parse(value) as { method: string }).method;
        if (method === 'subscribeNewToken')
          queueMicrotask(() => handlers.message(creationAck, false));
        if (method === 'subscribeMigration')
          queueMicrotask(() => {
            handlers.message(migrationAck, false);
            const creation = JSON.stringify({
              txType: 'create',
              mint: market.mint,
              signature: '1'.repeat(64),
            });
            handlers.message(creation, false);
            handlers.message(creation, false);
          });
      },
      ping() {
        handlers.pong();
      },
      close() {
        handlers.close(1000);
      },
      terminate() {
        handlers.close(1006);
      },
    };
  };
  // Explicit replay-time risk scheduling keeps the historical clock independent of DB wall time.
  const scanner = createScannerService(
    { ...config, SCANNER_ENABLED: true },
    createScannerRepository(db),
    logger,
    factory,
    undefined,
    undefined,
    () => new Date(at),
  );
  await scanner.start();
  try {
    await vi.waitFor(() => expect(scanner.metrics().duplicateEvents).toBe(1));
  } finally {
    await scanner.stop();
  }
  expect(
    await db.select().from(tokens).where(eq(tokens.mintAddress, market.mint)),
  ).toHaveLength(1);
  const discoveries = await db
    .select()
    .from(marketEvents)
    .where(eq(marketEvents.tokenMint, market.mint));
  expect(discoveries).toHaveLength(1);
  const discovery = discoveries[0]!;
  const repo = createRiskRepository(db);
  const clients = {
    ...config,
    JUPITER_TOKENS_BASE_URL: 'http://127.0.0.1:1234/tokens/v2',
    SOLANA_RPC_URL: 'http://127.0.0.1:1234',
  };
  let clock = Date.parse(at);
  const now = () => clock;
  const mockFetch: typeof fetch = async (url, init) => {
    if (init?.method === 'GET') {
      expect(new URL(String(url)).pathname).toBe('/tokens/v2/search');
      return new Response(
        JSON.stringify([
          jupiterPayload(market.mint, new Date(clock).toISOString()),
        ]),
      );
    }
    const payload = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    expect(payload).toMatchObject({
      method: 'getMultipleAccounts',
      params: [[market.mint], expect.any(Object)],
    });
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'solemn-risk',
        result: {
          context: { slot: 123 },
          value: [mintAccount()],
        },
      }),
    );
  };
  const jupiter = new JupiterTokenClient(clients, mockFetch, undefined, now);
  const rpc = new TokenSecurityClient(clients, mockFetch, undefined, now);
  const signal = new AbortController().signal;
  const events: HistoricalEvent[] = [];
  let first = true;
  const assessments = new Set<string>();
  for (const event of source.events) {
    if (event.kind === 'DISCOVERY') {
      events.push({
        ...event,
        data: {
          ...event.data,
          sourceEventId: discovery.sourceEventId,
          rawPayload: { scannerEventId: discovery.id, synthetic: true },
        },
      });
      continue;
    }
    if (event.kind !== 'RISK') {
      events.push(event);
      continue;
    }
    clock = Date.parse(event.availableAt);
    const requestId = first ? discovery.id : event.data.currentRequestId!;
    first = false;
    expect(await repo.request(market.mint, requestId, event.availableAt)).toBe(
      true,
    );
    const [job] = await repo.claim(1, event.availableAt, 30000, 1, market.mint);
    if (!job) throw new Error('Expected risk job for release fixture');
    const [metadata, security] = await Promise.all([
      jupiter.getMany([market.mint], signal),
      rpc.getMany([market.mint], signal),
    ]);
    const assessment = evaluateTokenRisk(
      job,
      metadata.get(market.mint)!,
      security.get(market.mint)!,
      riskPolicy(config),
      event.availableAt,
    );
    expect(assessment.status).toBe('ELIGIBLE');
    expect(await repo.persist(assessment, null)).toBe('CURRENT');
    assessments.add(assessment.id);
    events.push({
      ...event,
      data: {
        ...event.data,
        currentStatus: assessment.status,
        currentRequestId: assessment.requestId,
        assessment,
      },
    });
  }
  return {
    assessments,
    provider: createReplayProvider(config, { ...source, events }, [
      {
        start: '2026-01-01T00:16:10.000Z',
        end: '2026-01-01T00:17:15.000Z',
        reason: 'FIXTURE_DISCONNECT',
      },
    ]),
  };
}
