import {
  fromAtomic,
  idSchema,
  paperAccountDefinitionSchema,
  paperCommandSchema,
  paperPortfolioStateSchema,
  stableHash,
  stableId,
  toAtomic,
} from '@solemn/shared';
import type {
  PaperAccountDefinition,
  PaperCommand,
  PaperPortfolioState,
  PoolSnapshot,
} from '@solemn/shared';
import type { createSwapAuditRepository, SwapAuditRow } from '@solemn/database';
import type { Config } from '../config/index.js';
import { ceilDivide, percentOf } from '../portfolio/decimal.js';
import { entryRiskReasons } from '../risk/riskManager.js';
import { estimateSwapFees } from './feeEstimator.js';
import { quoteExactInput } from './simulation/poolModels.js';
import { swapRequestSchema, usdc, wrappedSol } from './jupiter/amounts.js';
import type { SwapRequest } from './jupiter/amounts.js';
import type {
  JupiterSwapClient,
  QuoteResult,
  SwapQuote,
} from './jupiter/jupiterClient.js';
import {
  quoteFreshness,
  ready,
  validateQuote,
} from './jupiter/quoteValidation.js';
import type { Decision } from './jupiter/quoteValidation.js';
import { inspectTransaction } from './jupiter/transactionInspector.js';
import type { Inspection } from './jupiter/transactionInspector.js';
import type {
  Simulation,
  TransactionSimulator,
} from './jupiter/transactionSimulator.js';
import type { createLogger } from '../services/logger.js';

type Entry = Extract<PaperCommand, { type: 'ENTRY' }>;
type AuditStore = ReturnType<typeof createSwapAuditRepository>;
type EntryEvidence = {
  command: Entry;
  definition: PaperAccountDefinition;
  state: PaperPortfolioState;
};
const tokenPrograms = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const insufficient = (reason: string): Decision => ({
  status: 'INSUFFICIENT_DATA',
  reason,
});
const rejected = (reason: string): Decision => ({ status: 'REJECTED', reason });
const unsupported = (reason: string): Decision => ({
  status: 'UNSUPPORTED',
  reason,
});
const liveFixtureRejected = unsupported(
  'LIVE_SIGNAL_AND_EXECUTION_EVIDENCE_NOT_AVAILABLE',
);
const roundUpUsd = (units: string, decimals: number, rate: string) =>
  ceilDivide(BigInt(units) * toAtomic(rate), 10n ** BigInt(decimals));

function paperComparison(pool: PoolSnapshot, quote: SwapQuote, at: string) {
  try {
    if (at >= pool.fees.validUntil || pool.availableAt > at)
      return {
        status: 'NON_COMPARABLE',
        reason: 'POOL_OR_FEE_SCHEDULE_OUTSIDE_WINDOW',
      };
    const paper = quoteExactInput(pool, 'BUY', BigInt(quote.inAmount));
    return {
      status: 'HYPOTHETICAL_SAME_INPUT',
      paperOutputBaseUnits: paper.output.toString(),
      jupiterOutputBaseUnits: quote.outAmount,
      outputDifferenceBaseUnits: (
        BigInt(quote.outAmount) - paper.output
      ).toString(),
      pool: pool.poolAddress,
      sameDirectPool:
        quote.routePlan.length === 1 &&
        quote.routePlan[0]?.swapInfo.ammKey === pool.poolAddress,
      reason: 'ROUTES_AND_FEE_MODELS_MAY_DIFFER',
    };
  } catch {
    return { status: 'NON_COMPARABLE', reason: 'PAPER_POOL_MODEL_UNAVAILABLE' };
  }
}

export class ExecutionReadinessService {
  private readonly inFlight = new Map<
    string,
    { fingerprint: string; result: Promise<SwapAuditRow> }
  >();
  constructor(
    private readonly config: Config,
    private readonly client: JupiterSwapClient,
    private readonly repository: AuditStore,
    private readonly rpc?: TransactionSimulator,
    private readonly now: () => number = Date.now,
    private readonly logger?: ReturnType<typeof createLogger>,
  ) {}

  /** Standalone quote research without a signal, risk assessment, portfolio or wallet. */
  async observe(requestInput: SwapRequest, requestId: string) {
    const request = swapRequestSchema.parse(requestInput);
    return this.run(
      stableId(['swap-observation-v1', idSchema.parse(requestId)]),
      request,
      null,
      false,
    );
  }

  /** Separate observer for a paper entry. It never calls the portfolio reducer or accepts a signing object. */
  async assessEntry(
    requestInput: SwapRequest,
    evidence: EntryEvidence,
    prepare = false,
  ) {
    const request = swapRequestSchema.parse(requestInput);
    const command = paperCommandSchema.parse(evidence.command);
    if (command.type !== 'ENTRY') throw new Error('Expected an entry command');
    const definition = paperAccountDefinitionSchema.parse(evidence.definition);
    const state = paperPortfolioStateSchema.parse(evidence.state);
    return this.run(
      stableId(['swap-entry-v1', definition.id, command.candidate.id]),
      request,
      { command, definition, state },
      prepare,
    );
  }

  private async run(
    id: string,
    request: SwapRequest,
    evidence: EntryEvidence | null,
    prepare: boolean,
  ) {
    const portfolioId = evidence?.definition.id ?? null;
    const signalId = evidence?.command.candidate.id ?? null;
    const fingerprint = stableHash(
      [
        request,
        portfolioId,
        signalId,
        evidence?.command.candidate.configHash,
        evidence?.definition.configHash,
        this.client.source,
        prepare,
      ].map((value) => value ?? null),
    );
    const pending = this.inFlight.get(id);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new Error('Conflicting assessment request');
      return pending.result;
    }
    if (this.inFlight.size >= 64)
      throw new Error('Execution readiness service busy');
    const work = async () => {
      const stored = await this.repository.find(id);
      if (stored) {
        if (stored.fingerprint !== fingerprint)
          throw new Error('Conflicting assessment request');
        return stored;
      }
      const payload = await this.evaluate(id, request, evidence, prepare);
      const row = await this.repository.save({
        id,
        portfolioId,
        signalId,
        fingerprint,
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        inputAmount: request.amount,
        source: this.client.source,
        status: payload.decision.status,
        quoteId: payload.quote?.id ?? null,
        assessedAt: new Date(this.now()).toISOString(),
        payload: {
          version: 'SOLEMN_SWAP_AUDIT_V1',
          request,
          policy: {
            maxQuoteAgeMs: this.config.JUPITER_MAX_QUOTE_AGE_MS,
            maxSlippageBps: this.config.JUPITER_MAX_SLIPPAGE_BPS,
            maxFeeBps: this.config.JUPITER_MAX_FEE_BPS,
            maxAdverseImpactBps: this.config.JUPITER_MAX_PRICE_IMPACT_BPS,
          },
          evidence: evidence
            ? {
                paperConfigHash: evidence.definition.configHash,
                strategyConfigHash: stableHash(
                  evidence.definition.strategyPolicy,
                ),
                strategyVersion: evidence.definition.strategyPolicy.version,
                riskAssessmentId: evidence.command.risk?.assessment?.id ?? null,
                marketObservationId: evidence.command.observation?.id ?? null,
                marketObservedAt:
                  evidence.command.observation?.observedAt ?? null,
                portfolioAsOf: evidence.state.asOf,
              }
            : null,
          ...payload,
        },
      });
      this.logger?.info(
        {
          assessmentId: id,
          signalId,
          quoteId: row.quoteId,
          status: row.status,
        },
        'Dry-run assessment persisted',
      );
      return row;
    };
    const result = work().finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, { fingerprint, result });
    return result;
  }

  private async evaluate(
    id: string,
    request: SwapRequest,
    evidence: EntryEvidence | null,
    prepare: boolean,
  ) {
    let quote: SwapQuote | null = null,
      preparedQuote: SwapQuote | null = null;
    let providerFailure: Exclude<QuoteResult, { status: 'QUOTED' }> | null =
      null;
    type FeeEstimate = ReturnType<typeof estimateSwapFees>;
    let fees: FeeEstimate | null = null,
      preparedFees: FeeEstimate | null = null;
    let comparison: ReturnType<typeof paperComparison> | null = null;
    let inspection: Inspection | null = null,
      simulation: Simulation | null = null;
    let preparationId: string | null = null;
    let quoteCheck: Decision | null = null;
    let allocation: {
      inputNotionalUsd: string;
      paperBudgetUsd: string;
      grossDebitUpperBoundUsd: string | null;
    } | null = null;
    const riskReasons: string[] = [];
    const signalId = evidence?.command.candidate.id ?? null;
    const finish = (decision: Decision) => {
      if (decision.status !== 'READY_FOR_DRY_RUN')
        this.logger?.info(
          {
            assessmentId: id,
            signalId,
            quoteId: quote?.id,
            preparationId,
            ...decision,
          },
          'Execution readiness limited',
        );
      return {
        decision,
        quoteCheck,
        quote,
        preparedQuote,
        providerFailure,
        fees,
        preparedFees,
        comparison,
        preparationId,
        inspection,
        simulation,
        allocation,
        riskReasons,
      };
    };
    const time = () => new Date(this.now()).toISOString();
    const checkEvidence = () => {
      if (!evidence) return ready;
      if (
        this.client.source !== 'LOOPBACK_TEST' ||
        evidence.definition.dataMode === 'FORWARD_LIVE'
      )
        return liveFixtureRejected;
      const { command, state, definition } = evidence;
      const at = time();
      if (
        state.id !== definition.id ||
        state.asOf > at ||
        command.candidate.candleEnd > command.candidate.timestamp ||
        command.at > at ||
        command.candidate.timestamp > command.at
      )
        return rejected('INVALID_SIGNAL_OR_PORTFOLIO_CONTEXT');
      if (!command.risk?.assessment)
        return insufficient('CURRENT_TOKEN_RISK_UNAVAILABLE');
      const reasons = entryRiskReasons({ ...command, at }, state, definition);
      if (reasons.length) {
        riskReasons.push(...reasons);
        return rejected('PAPER_ENTRY_RISK_REJECTED');
      }
      if (
        state.executionUncertain ||
        state.positions.some(
          (position) =>
            position.status !== 'CLOSED' &&
            (!position.mark ||
              position.valuationStale ||
              position.liquidationUncertain ||
              position.status === 'EXIT_BLOCKED' ||
              this.now() - Date.parse(position.mark.observedAt) >
                definition.policy.maxPriceAgeSeconds * 1000),
        )
      )
        return insufficient('PORTFOLIO_EQUITY_UNCERTAIN');
      const { observation } = command;
      const pool = observation?.pool;
      if (
        !observation?.healthy ||
        !observation.usdReliable ||
        observation.side !== 'BUY' ||
        !pool ||
        !pool.quoteUsd ||
        pool.quality === 'UNKNOWN' ||
        observation.receivedAt > at ||
        pool.availableAt > at ||
        this.now() - Date.parse(observation.observedAt) >
          definition.policy.maxPriceAgeSeconds * 1000 ||
        this.now() - Date.parse(pool.observedAt) >
          definition.policy.maxPriceAgeSeconds * 1000
      )
        return insufficient('MARKET_OBSERVATION_UNAVAILABLE_OR_STALE');
      if (
        pool.transfers !== 'ENABLED' ||
        BigInt(pool.baseReserve) === 0n ||
        BigInt(pool.quoteReserve) === 0n
      )
        return unsupported('POOL_TRANSFERS_OR_LIQUIDITY_UNSUPPORTED');
      if (
        ![wrappedSol, usdc].includes(request.inputMint) ||
        request.outputMint !== command.candidate.mint ||
        observation.mint !== request.outputMint ||
        observation.poolAddress !== command.candidate.poolAddress ||
        pool.poolAddress !== observation.poolAddress ||
        pool.baseMint !== request.outputMint ||
        pool.quoteMint !== request.inputMint ||
        pool.baseDecimals !== request.outputDecimals ||
        pool.quoteDecimals !== request.inputDecimals
      )
        return unsupported('SIGNAL_PAIR_OR_DECIMALS_MISMATCH');
      const security = command.risk.assessment.evidence.solana;
      if (
        security.validMint !== true ||
        security.decimals !== request.outputDecimals ||
        !security.tokenProgram ||
        !tokenPrograms.has(security.tokenProgram)
      )
        return insufficient('TOKEN_PROGRAM_OR_DECIMALS_UNVERIFIED');
      const notional = roundUpUsd(
        request.amount,
        request.inputDecimals,
        pool.quoteUsd,
      );
      const maximum = percentOf(
        toAtomic(state.equityUsd),
        definition.policy.maxPositionPercent,
      );
      const cash = toAtomic(state.availableCashUsd);
      const budget = maximum < cash ? maximum : cash;
      allocation = {
        inputNotionalUsd: fromAtomic(notional),
        paperBudgetUsd: fromAtomic(budget),
        grossDebitUpperBoundUsd: null,
      };
      if (
        notional > budget ||
        notional < toAtomic(definition.policy.minimumOrderUsd)
      )
        return rejected('PAPER_ALLOCATION_EXCEEDED_OR_BELOW_MINIMUM');
      return ready;
    };
    const nativeRate = () => {
      const observation = evidence?.command.observation;
      const native = observation?.nativeUsd;
      if (
        native &&
        native.availableAt <= time() &&
        this.now() - Date.parse(native.observedAt) <=
          (evidence?.definition.policy.maxPriceAgeSeconds ?? 0) * 1000
      )
        return native.priceUsd;
      return observation?.pool?.quoteMint === wrappedSol
        ? observation.pool.quoteUsd
        : null;
    };
    const checkAllocation = (
      estimated: ReturnType<typeof estimateSwapFees>,
    ) => {
      const limit = allocation as NonNullable<typeof allocation> | null;
      if (!limit) return ready;
      if (estimated.estimatedSolDebitsUpperBoundUsd === null)
        return insufficient('NETWORK_OR_RENT_COST_UNPRICED');
      const gross =
        toAtomic(limit.inputNotionalUsd) +
        toAtomic(estimated.estimatedSolDebitsUpperBoundUsd);
      limit.grossDebitUpperBoundUsd = fromAtomic(gross);
      return gross > toAtomic(limit.paperBudgetUsd)
        ? rejected('PAPER_ALLOCATION_WITH_FEES_EXCEEDED')
        : ready;
    };
    const checkQuote = async (candidate: SwapQuote) => {
      const preliminary = validateQuote(
        candidate,
        this.config,
        request.slippageBps,
      );
      if (preliminary.status !== 'READY_FOR_DRY_RUN') return preliminary;
      const fresh = quoteFreshness(
        candidate,
        this.now(),
        this.config.JUPITER_MAX_QUOTE_AGE_MS,
      );
      if (fresh.reason !== 'BLOCK_HEIGHT_UNVERIFIED') return fresh;
      return quoteFreshness(
        candidate,
        this.now(),
        this.config.JUPITER_MAX_QUOTE_AGE_MS,
        await this.rpc?.currentBlockHeight(),
      );
    };
    const preflight = checkEvidence();
    if (preflight.status !== 'READY_FOR_DRY_RUN') return finish(preflight);
    this.logger?.info(
      {
        assessmentId: id,
        signalId,
        inputMint: request.inputMint,
        outputMint: request.outputMint,
      },
      'Jupiter quote requested',
    );
    const observed = await this.client.order(request);
    if (observed.status !== 'QUOTED') {
      providerFailure = observed;
      return finish(observed);
    }
    quote = observed.quote;
    this.logger?.info(
      {
        assessmentId: id,
        signalId,
        quoteId: quote.id,
        router: quote.router,
        latencyMs: quote.latencyMs,
      },
      'Jupiter quote received',
    );
    fees = estimateSwapFees(quote, nativeRate());
    quoteCheck = await checkQuote(quote);
    if (quoteCheck.status !== 'READY_FOR_DRY_RUN') return finish(quoteCheck);
    if (!evidence)
      return finish(insufficient('SIGNAL_AND_PORTFOLIO_NOT_ASSESSED'));
    const afterQuote = checkEvidence();
    if (afterQuote.status !== 'READY_FOR_DRY_RUN') return finish(afterQuote);
    const pool = evidence.command.observation?.pool;
    if (pool) comparison = paperComparison(pool, quote, time());
    const allocated = checkAllocation(fees);
    if (allocated.status !== 'READY_FOR_DRY_RUN' || !prepare)
      return finish(allocated);

    const built = await this.client.order(request, 'prepare');
    if (built.status !== 'QUOTED') {
      providerFailure = built;
      return finish(built);
    }
    preparedQuote = built.quote;
    preparationId = stableId(['swap-preparation-v1', id, preparedQuote.id]);
    preparedFees = estimateSwapFees(preparedQuote, nativeRate());
    const builtCheck = await checkQuote(preparedQuote);
    if (builtCheck.status !== 'READY_FOR_DRY_RUN') return finish(builtCheck);
    const refreshed = checkEvidence();
    if (refreshed.status !== 'READY_FOR_DRY_RUN') return finish(refreshed);
    const builtAllocation = checkAllocation(preparedFees);
    if (builtAllocation.status !== 'READY_FOR_DRY_RUN')
      return finish(builtAllocation);
    if (!built.unsignedTransaction || !preparedQuote.taker)
      return finish(unsupported('UNSIGNED_TRANSACTION_MISSING'));
    if (
      preparedQuote.signatureFeePayer &&
      preparedQuote.signatureFeePayer !== preparedQuote.taker
    )
      return finish(unsupported('SPONSORED_FEE_PAYER_UNSUPPORTED'));
    if (!preparedQuote.lastValidBlockHeight && !preparedQuote.expireAt)
      return finish(insufficient('PREPARED_TRANSACTION_EXPIRY_UNVERIFIED'));
    inspection = inspectTransaction(
      built.unsignedTransaction,
      preparedQuote.taker,
      preparedQuote.transactionVersion ?? 0,
      request,
    );
    this.logger?.info(
      {
        assessmentId: id,
        preparationId,
        status: inspection.status,
        reason: inspection.reason,
      },
      'Unsigned transaction inspected',
    );
    if (inspection.status === 'REJECTED')
      return finish(rejected(inspection.reason));
    if (inspection.status === 'INSPECTED')
      return finish(rejected('PREPARED_TRANSACTION_CONTAINS_NO_SWAP'));
    if (inspection.diagnosticSimulationAllowed && this.rpc) {
      const deadline = Math.min(
        Date.parse(preparedQuote.requestedAt) +
          this.config.JUPITER_MAX_QUOTE_AGE_MS,
        preparedQuote.expireAt ? Date.parse(preparedQuote.expireAt) : Infinity,
      );
      this.logger?.info(
        { assessmentId: id, preparationId },
        'Diagnostic RPC simulation requested',
      );
      simulation = await this.rpc.simulate(
        built.unsignedTransaction,
        preparedQuote.taker,
        deadline,
      );
      this.logger?.info(
        {
          assessmentId: id,
          preparationId,
          status: simulation.status,
          reason: simulation.reason,
        },
        'Diagnostic RPC simulation finished',
      );
      if (
        simulation.programError === 'BlockhashNotFound' ||
        this.now() >= deadline
      )
        return finish({
          status: 'EXPIRED',
          reason: 'SIMULATION_BLOCKHASH_OR_QUOTE_EXPIRED',
        });
      if (simulation.status === 'SIMULATION_FAILED')
        return finish(rejected('RPC_SIMULATION_FAILED'));
    }
    return finish(unsupported(inspection.reason));
  }
}
