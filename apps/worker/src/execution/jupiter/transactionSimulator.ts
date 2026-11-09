import { createHash } from 'node:crypto';
import { parse, isLosslessNumber } from 'lossless-json';
import { z } from 'zod';
import { isReadOnlyRpcUrl } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import {
  HttpReader,
  ProviderError,
  providerError,
} from '../../analysis/httpReader.js';
import { uintFromJson } from './jupiterClient.js';
import { inspectTransaction } from './transactionInspector.js';

const envelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.preprocess(
    (value) => (isLosslessNumber(value) ? value.value : null),
    z.literal('1'),
  ),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const simulationResult = z.object({
  context: z.object({ slot: uintFromJson }),
  value: z.object({
    err: z.unknown(),
    unitsConsumed: uintFromJson.nullish(),
    fee: uintFromJson.nullish(),
    logs: z.array(z.string().max(8192)).max(2048).nullish(),
  }),
});
const recognizedErrors = new Set([
  'AccountNotFound',
  'InsufficientFundsForFee',
  'InvalidAccountForFee',
  'BlockhashNotFound',
  'InvalidProgramForExecution',
  'ProgramAccountNotFound',
  'SignatureFailure',
  'ComputationalBudgetExceeded',
  'InsufficientFunds',
  'UninitializedAccount',
  'InvalidAccountData',
  'InvalidInstructionData',
  'IncorrectProgramId',
  'MissingRequiredSignature',
]);
function errorCode(error: unknown): string {
  if (typeof error === 'string' && recognizedErrors.has(error)) return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'InstructionError' in error &&
    Array.isArray(error.InstructionError)
  ) {
    const reason: unknown = error.InstructionError[1];
    if (typeof reason === 'object' && reason !== null && 'Custom' in reason) {
      const code = uintFromJson.safeParse(reason.Custom);
      if (code.success) return 'InstructionError:Custom:' + code.data;
    }
    if (typeof reason === 'string' && recognizedErrors.has(reason))
      return 'InstructionError:' + reason;
    return 'InstructionError:UNCLASSIFIED';
  }
  return 'UNCLASSIFIED_RPC_PROGRAM_ERROR';
}
const usefulLog =
  /^Program [1-9A-HJ-NP-Za-km-z]{32,44} (?:invoke \[\d{1,3}\]|success|consumed \d{1,12} of \d{1,12} compute units|failed: custom program error: 0x[0-9a-fA-F]{1,8})$/;

export class TransactionSimulator {
  private readonly reader: HttpReader;
  private readonly endpointId: string;
  private readonly endpoint: string;
  constructor(
    private readonly config: Config,
    fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const url = new URL(config.SOLANA_RPC_URL);
    if (!isReadOnlyRpcUrl(url))
      throw new Error('Unsupported simulation RPC endpoint');
    this.endpoint = url.href;
    // Do not identify a provider by credential-bearing path or query.
    this.endpointId = createHash('sha256')
      .update(url.origin)
      .digest('hex')
      .slice(0, 16);
    this.reader = new HttpReader(
      { ...config, RISK_HTTP_MAX_ATTEMPTS: 1 },
      config.RISK_RPC_REQUEST_INTERVAL_MS,
      fetcher,
      undefined,
      now,
    );
  }

  async #rpc(
    method: 'getBlockHeight' | 'simulateTransaction',
    params: unknown[],
    notAfter?: number,
  ) {
    const timeout = Math.min(
      this.config.RISK_HTTP_TIMEOUT_MS + 2000,
      notAfter === undefined ? Infinity : notAfter - this.now(),
    );
    if (timeout <= 0) throw new Error('RPC_DEADLINE_EXCEEDED');
    const { body } = await this.reader.request(
      this.endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      },
      AbortSignal.timeout(timeout),
    );
    const data = envelope.safeParse(parse(body));
    if (!data.success || data.data.error != null)
      throw new ProviderError({
        code: 'INVALID_RESPONSE',
        httpStatus: null,
        retryAt: null,
      });
    return data.data.result;
  }

  async currentBlockHeight(): Promise<bigint | null> {
    if (!this.config.JUPITER_RPC_SIMULATION_ENABLED) return null;
    try {
      return BigInt(
        uintFromJson.parse(
          await this.#rpc('getBlockHeight', [{ commitment: 'confirmed' }]),
        ),
      );
    } catch {
      return null;
    }
  }

  async simulate(base64: string, taker: string, notAfter?: number) {
    const base = {
      status: 'UNVERIFIABLE' as
        'UNVERIFIABLE' | 'SIMULATED' | 'SIMULATION_FAILED',
      reason: 'RPC_SIMULATION_DISABLED',
      attempted: false,
      rpcEndpointId: this.endpointId,
      at: new Date(this.now()).toISOString(),
      slot: null as string | null,
      unitsConsumed: null as string | null,
      estimatedFeeLamports: null as string | null,
      programError: null as string | null,
      logs: [] as string[],
      logsAvailable: false,
      limitations: ['SIGNATURES_NOT_VERIFIED', 'CONFIRMED_STATE_SNAPSHOT'],
    };
    if (!this.config.JUPITER_RPC_SIMULATION_ENABLED) return base;
    // Reinspect these exact bytes at the network boundary. No caller-supplied approval is trusted.
    if (!inspectTransaction(base64, taker).diagnosticSimulationAllowed)
      return { ...base, reason: 'INSPECTION_BLOCKS_SIMULATION' };
    if (notAfter !== undefined && this.now() >= notAfter)
      return { ...base, reason: 'QUOTE_EXPIRED_BEFORE_SIMULATION' };
    try {
      const response = simulationResult.parse(
        await this.#rpc(
          'simulateTransaction',
          [
            base64,
            {
              encoding: 'base64',
              sigVerify: false,
              replaceRecentBlockhash: false,
              commitment: 'confirmed',
            },
          ],
          notAfter,
        ),
      );
      const value = response.value;
      if (!Object.hasOwn(value, 'err'))
        return {
          ...base,
          attempted: true,
          reason: 'RPC_RESULT_MISSING_ERROR_FIELD',
        };
      const details = {
        ...base,
        attempted: true,
        slot: response.context.slot,
        unitsConsumed: value.unitsConsumed ?? null,
        estimatedFeeLamports: value.fee ?? null,
        logsAvailable: value.logs != null,
        logs:
          value.logs?.filter((line) => usefulLog.test(line)).slice(0, 24) ?? [],
        limitations: [
          ...base.limitations,
          ...(value.logs == null ? ['PROGRAM_LOGS_UNAVAILABLE'] : []),
        ],
      };
      if (value.err !== null)
        return {
          ...details,
          status: 'SIMULATION_FAILED' as const,
          reason: 'RPC_TRANSACTION_ERROR',
          programError: errorCode(value.err),
        };
      return {
        ...details,
        status: 'SIMULATED' as const,
        reason: 'RPC_REPORTED_NO_ERROR',
      };
    } catch (error) {
      return {
        ...base,
        attempted: true,
        reason:
          error instanceof SyntaxError || error instanceof z.ZodError
            ? 'INVALID_RPC_RESPONSE'
            : providerError(error).code,
      };
    }
  }
}

export type Simulation = Awaited<ReturnType<TransactionSimulator['simulate']>>;
