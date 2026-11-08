import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createScannerRepository,
  marketEvents,
  migrateDatabase,
  scannerGaps,
  tokens,
} from '@solemn/database';
import { loadConfig } from '../src/config/index.js';
import { createScannerService } from '../src/scanner/scannerService.js';
import {
  creationAck,
  launchRaw,
  migrationAck,
  migrationRaw,
  MINT,
} from './scannerFixtures.js';

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

it('ingests launches, duplicates and migrations through a local socket, reconnects and drains into PostgreSQL', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing mock port');
  const connections: { socket: WebSocket; methods: string[] }[] = [];
  server.on('connection', (socket) => {
    const connection = { socket, methods: [] as string[] };
    connections.push(connection);
    socket.on('message', (data) => {
      const method = (JSON.parse(data.toString()) as { method: string }).method;
      connection.methods.push(method);
      if (method === 'subscribeNewToken') socket.send(creationAck);
      else if (method === 'subscribeMigration') socket.send(migrationAck);
      else throw new Error('Unexpected paid/unsupported subscription');
    });
  });
  const rollback = new Error('ROLLBACK_E2E_FIXTURES');
  try {
    await database.db.transaction(async (tx) => {
      const scanner = createScannerService(
        loadConfig({
          DATABASE_URL: 'postgresql://localhost/solemn',
          SCANNER_ENABLED: 'true',
          PUMPPORTAL_WS_URL: `ws://127.0.0.1:${address.port}`,
          SCANNER_RECONNECT_INITIAL_MS: '10',
          SCANNER_RECONNECT_MAX_MS: '30',
        }),
        createScannerRepository(tx),
        pino({ level: 'silent' }),
      );
      try {
        await scanner.start();
        await vi.waitFor(() =>
          expect(connections[0]?.methods).toEqual([
            'subscribeNewToken',
            'subscribeMigration',
          ]),
        );
        connections[0]?.socket.send(launchRaw);
        connections[0]?.socket.send(launchRaw);
        connections[0]?.socket.send(migrationRaw);
        await vi.waitFor(
          () =>
            expect(scanner.metrics()).toMatchObject({
              successfulWrites: 2,
              duplicateEvents: 1,
            }),
          { timeout: 5000 },
        );
        connections[0]?.socket.terminate();
        await vi.waitFor(
          () =>
            expect(connections[1]?.methods).toEqual([
              'subscribeNewToken',
              'subscribeMigration',
            ]),
          { timeout: 5000 },
        );
        expect(server.clients.size).toBe(1);
        connections[1]?.socket.send(launchRaw);
        await vi.waitFor(() =>
          expect(scanner.metrics().duplicateEvents).toBe(2),
        );
        await scanner.waitForIdle();
        const tokenRows = await tx
          .select()
          .from(tokens)
          .where(eq(tokens.mintAddress, MINT));
        expect(tokenRows).toHaveLength(1);
        expect(tokenRows[0]?.migrationStatus).toBe('MIGRATED');
        const rows = await tx
          .select()
          .from(marketEvents)
          .where(eq(marketEvents.tokenMint, MINT));
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.rawMessage)).toContain(launchRaw);
        expect(rows.map((row) => row.eventType).sort()).toEqual([
          'TOKEN_CREATED',
          'TOKEN_MIGRATED',
        ]);
        expect(scanner.metrics().reconnections).toBe(1);
      } finally {
        await scanner.stop();
      }
      const gaps = await tx
        .select()
        .from(scannerGaps)
        .where(eq(scannerGaps.source, 'PUMPPORTAL'));
      expect(
        gaps.some(
          (gap) => gap.reason === 'DISCONNECTED' && gap.endedAt !== null,
        ),
      ).toBe(true);
      expect(
        gaps.some((gap) => gap.reason === 'SHUTDOWN' && gap.endedAt === null),
      ).toBe(true);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
