import { executionConfigSchema } from '@solemn/shared';
import type { ExecutionConfig } from '@solemn/shared';
export const scenarioNames = [
  'idealized',
  'baseline',
  'pessimistic',
  'extreme',
] as const;
export function executionScenario(
  name: ExecutionConfig['scenario'],
  seed = 42,
): ExecutionConfig {
  const total = {
    idealized: 300,
    baseline: 1000,
    pessimistic: 3000,
    extreme: 10000,
  }[name];
  return executionConfigSchema.parse({
    modelVersion: 'SOLEMN_EXECUTION_V1',
    revision: '1.0.1',
    mode: 'PAPER',
    scenario: name,
    seed,
    ...(name === 'extreme'
      ? {
          networkOutages: [
            {
              start: '2026-01-01T00:15:59.000Z',
              end: '2026-01-01T00:16:15.000Z',
            },
          ],
        }
      : {}),
    maxSlippageBps: 500,
    maxQuoteAgeMs: 15000,
    latency: {
      processingMs: 20,
      quoteMs: 30,
      preparationMs: 50,
      submissionMs: 50,
      landingMs: total - 150,
    },
    network: {
      format: 'V0',
      signatures: 1,
      baseLamportsPerSignature: name === 'idealized' ? '0' : '5000',
      computeUnitLimit: 200000,
      microLamportsPerCu:
        name === 'idealized'
          ? '0'
          : name === 'baseline'
            ? '1000'
            : name === 'pessimistic'
              ? '100000'
              : '500000',
      absolutePriorityLamports: '0',
      tipLamports: '0',
      routeRequiresTip: false,
      availableLamports: '100000000',
      rentDepositLamports: '0',
      source: 'SOLEMN research assumptions; not observed historical fees',
      validFrom: '2020-01-01T00:00:00.000Z',
      validUntil: '2030-01-01T00:00:00.000Z',
    },
    droppedBps: name === 'extreme' ? 2000 : name === 'pessimistic' ? 500 : 0,
    failedBps: name === 'extreme' ? 2000 : name === 'pessimistic' ? 1000 : 0,
    ambiguousBps: name === 'extreme' ? 500 : 0,
    maxAttemptsPerPosition: 3,
  });
}
