import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createPaperRepository,
  createStrategyRepository,
  createSwapAuditRepository,
  migrateDatabase,
  orders,
  positions,
  strategyRun,
  swapExecutionAssessments,
  trades,
} from '@solemn/database';
import { stableHash } from '@solemn/shared';
import { ExecutionReadinessService } from '../src/execution/executionReadiness.js';
import { JupiterSwapClient } from '../src/execution/jupiter/jupiterClient.js';
import { TransactionSimulator } from '../src/execution/jupiter/transactionSimulator.js';
import { policyHash } from '../src/risk/tokenRiskEngine.js';
import {
  entryFixture,
  opaqueSwapFixture,
  providerQuote,
  swapConfig,
  taker,
} from './jupiterFixtures.js';

dotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const db = createDatabase(
  assertSafeTestDatabase(
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
  ),
);
beforeAll(() => migrateDatabase(db.db));
afterAll(() => db.close());

it.each([
  {
    scenario: 'simulated',
    final: 'UNSUPPORTED',
    simulation: 'SIMULATED',
    swaps: 2,
    rpc: ['getBlockHeight', 'simulateTransaction'],
  },
  {
    scenario: 'failed',
    final: 'REJECTED',
    simulation: 'SIMULATION_FAILED',
    swaps: 2,
    rpc: ['getBlockHeight', 'simulateTransaction'],
  },
  {
    scenario: 'expired',
    final: 'EXPIRED',
    simulation: null,
    swaps: 1,
    rpc: [],
  },
  {
    scenario: 'stale risk',
    final: 'REJECTED',
    simulation: null,
    swaps: 0,
    rpc: [],
  },
  {
    scenario: 'stale market',
    final: 'INSUFFICIENT_DATA',
    simulation: null,
    swaps: 0,
    rpc: [],
  },
  {
    scenario: 'allocation',
    final: 'REJECTED',
    simulation: null,
    swaps: 0,
    rpc: [],
  },
  {
    scenario: 'quote only',
    final: 'READY_FOR_DRY_RUN',
    simulation: null,
    swaps: 1,
    rpc: [],
  },
])('audits $scenario without touching the paper ledger', async (example) => {
  const evidence = await entryFixture();
  const { command, definition, state, posting, now, fixture } = evidence;
  const request =
    example.scenario === 'allocation'
      ? { ...evidence.request, amount: '20000000' }
      : evidence.request;
  if (example.scenario === 'stale risk' && command.risk?.assessment)
    command.risk.assessment.validUntil = new Date(now).toISOString();
  if (example.scenario === 'stale market' && command.observation)
    command.observation.observedAt = new Date(now - 16000).toISOString();
  const transaction = opaqueSwapFixture(request);
  const swapCalls: {
    method?: string;
    path: string;
    taker: string | null;
    amount: string | null;
    key: string | string[] | undefined;
  }[] = [];
  const rpcCalls: { method: string; params: unknown[] }[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? '/', 'http://localhost');
      outgoing.setHeader('content-type', 'application/json');
      if (incoming.method === 'GET' && url.pathname === '/swap/v2/order') {
        const publicTaker = url.searchParams.get('taker');
        swapCalls.push({
          method: incoming.method,
          path: url.pathname,
          taker: publicTaker,
          amount: url.searchParams.get('amount'),
          key: incoming.headers['x-api-key'],
        });
        outgoing.end(
          JSON.stringify(
            providerQuote(request, {
              taker: publicTaker,
              transaction: publicTaker ? transaction : null,
              ...(publicTaker
                ? {
                    transactionVersion: 0,
                    lastValidBlockHeight: '100',
                    signatureFeePayer: taker,
                  }
                : {}),
              ...(example.scenario === 'expired'
                ? { expireAt: new Date(now - 1).toISOString() }
                : {}),
            }),
          ),
        );
      } else if (incoming.method === 'POST' && url.pathname === '/rpc') {
        const chunks = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          id: number;
          method: string;
          params: unknown[];
        };
        rpcCalls.push(body);
        if (body.method === 'getBlockHeight')
          outgoing.end(
            JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 99 }),
          );
        else if (body.method === 'simulateTransaction')
          outgoing.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                context: { slot: 1000 },
                value: {
                  err:
                    example.scenario === 'failed'
                      ? { InstructionError: [0, { Custom: 42 }] }
                      : null,
                  unitsConsumed: 42000,
                  fee: 6000,
                  logs: ['Program log: excluded free text'],
                },
              },
            }),
          );
        else throw new Error('Unexpected RPC method');
      } else throw new Error('Unexpected endpoint');
    } catch {
      outgoing.statusCode = 400;
      outgoing.end('{"error":"UNEXPECTED_MOCK_REQUEST"}');
    }
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const listen = server.address();
    if (!listen || typeof listen === 'string')
      throw new Error('Mock listener unavailable');
    const origin = `http://127.0.0.1:${listen.port}`;
    const config = {
      ...swapConfig,
      JUPITER_SWAP_BASE_URL: origin + '/swap/v2',
      SOLANA_RPC_URL: origin + '/rpc',
      JUPITER_UNSIGNED_BUILD_ENABLED: true,
      JUPITER_RPC_SIMULATION_ENABLED: true,
      JUPITER_TAKER_PUBLIC_KEY: taker,
      JUPITER_API_KEY: 'must-not-reach-mock',
    };
    const rollback = new Error('ROLLBACK_SWAP_FIXTURE');
    try {
      await db.db.transaction(async (tx) => {
        const strategy = strategyRun(
          definition.strategyPolicy,
          policyHash(definition.riskPolicy),
          fixture.marketDataset,
        );
        await createStrategyRepository(tx).begin(strategy);
        const ledger = createPaperRepository(tx);
        await ledger.initialize(definition, state, posting);
        const before = stableHash(
          await ledger.snapshot(definition.id, { readOnly: true }),
        );
        const store = createSwapAuditRepository(tx);
        const clock = () => now;
        const service = new ExecutionReadinessService(
          config,
          new JupiterSwapClient(config, fetch, clock),
          store,
          new TransactionSimulator(config, fetch, clock),
          clock,
        );
        const prepare = example.scenario !== 'quote only';
        const [row, duplicate] = await Promise.all([
          service.assessEntry(request, evidence, prepare),
          service.assessEntry(request, evidence, prepare),
        ]);
        expect(duplicate).toEqual(row);
        expect(await service.assessEntry(request, evidence, prepare)).toEqual(
          row,
        );
        expect(row).toMatchObject({
          status: example.final,
          portfolioId: definition.id,
          signalId: command.candidate.id,
          source: 'LOOPBACK_TEST',
        });
        const payload = row.payload as Record<string, unknown>;
        if (example.swaps) {
          expect(payload).toMatchObject({
            quote: { inAmount: '10000000', outAmount: '800000' },
            request: { inputDecimals: 9, outputDecimals: 9 },
            fees: {
              estimatedSolDebitsUpperBoundUsd: '0.00048',
              totalCostComplete: false,
            },
          });
        }
        if (example.simulation) {
          expect(payload).toMatchObject({
            preparationId: expect.any(String),
            preparedQuote: {
              transactionStatus: 'AVAILABLE',
              lastValidBlockHeight: '100',
            },
            inspection: { version: 0, feePayer: taker, status: 'UNSUPPORTED' },
            simulation: {
              status: example.simulation,
              attempted: true,
              slot: '1000',
              unitsConsumed: '42000',
              estimatedFeeLamports: '6000',
            },
            comparison: {
              status: 'HYPOTHETICAL_SAME_INPUT',
              sameDirectPool: false,
            },
            allocation: {
              paperBudgetUsd: '1',
              grossDebitUpperBoundUsd: '0.80048',
            },
          });
        } else expect(payload.simulation).toBeNull();
        expect(JSON.stringify(payload)).not.toContain(transaction);
        expect(JSON.stringify(payload)).not.toContain('must-not-reach-mock');
        expect(
          stableHash(await ledger.snapshot(definition.id, { readOnly: true })),
        ).toBe(before);
        expect(
          await tx
            .select()
            .from(orders)
            .where(eq(orders.portfolioId, definition.id)),
        ).toHaveLength(0);
        expect(
          await tx
            .select()
            .from(trades)
            .where(eq(trades.portfolioId, definition.id)),
        ).toHaveLength(0);
        expect(
          await tx
            .select()
            .from(positions)
            .where(eq(positions.portfolioId, definition.id)),
        ).toHaveLength(0);
        expect(
          await tx
            .select()
            .from(swapExecutionAssessments)
            .where(eq(swapExecutionAssessments.id, row.id)),
        ).toHaveLength(1);
        await expect(
          tx.transaction((nested) =>
            nested
              .update(swapExecutionAssessments)
              .set({ status: 'REJECTED' })
              .where(eq(swapExecutionAssessments.id, row.id)),
          ),
        ).rejects.toThrow();
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    expect(swapCalls).toHaveLength(example.swaps);
    expect(
      swapCalls.every(
        (call) =>
          call.method === 'GET' &&
          call.path === '/swap/v2/order' &&
          call.amount === '10000000' &&
          call.key === undefined,
      ),
    ).toBe(true);
    if (example.swaps > 0) expect(swapCalls[0]?.taker).toBeNull();
    if (example.swaps === 2) expect(swapCalls[1]?.taker).toBe(taker);
    expect(rpcCalls.map((call) => call.method)).toEqual(example.rpc);
    if (rpcCalls.length)
      expect(rpcCalls.at(-1)?.params).toEqual([
        transaction,
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: 'confirmed',
        },
      ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
