import { validatePool } from '../execution/simulation/poolModels.js';
import { networkFees } from '../execution/simulation/feeModel.js';
import { fromAtomic, stableId, toAtomic } from '@solemn/shared';
import type {
  BuyCandidate,
  ExecutionContext,
  ExecutionObservation,
  PaperAccountDefinition,
  PaperCommand,
  PaperPortfolioState,
  PaperTransition,
} from '@solemn/shared';
import { observationProblem } from '../execution/paperExecutor.js';
import {
  buyQuantity,
  latencyMs,
  prepareQuote,
} from '../execution/simulation/executionSimulator.js';
import { executionMark } from '../execution/simulation/mark.js';
import { chooseExit } from '../portfolio/positionManager.js';
import { marketKey } from './candidateManager.js';
import type { CandidateManager } from './candidateManager.js';
import type { ForwardIntent, ReplayCheckpoint } from './checkpoint.js';

const addMs = (at: string, ms: number) =>
  new Date(Date.parse(at) + ms).toISOString();
export type WriteRuntimeEvent = (
  kind: string,
  key: string,
  details: Record<string, unknown>,
) => Promise<void>;

export class ForwardPaperFlow {
  private readonly execution;
  constructor(
    private readonly definition: PaperAccountDefinition,
    private readonly checkpoint: ReplayCheckpoint,
    private readonly watch: CandidateManager,
    private readonly state: () => PaperPortfolioState,
    private readonly commit: (
      command: PaperCommand,
    ) => Promise<PaperTransition>,
    private readonly record: WriteRuntimeEvent,
  ) {
    if (!definition.forwardExecution)
      throw new Error('Forward replay requires Week 7 execution');
    this.execution = definition.forwardExecution;
  }
  private scope(intent: ForwardIntent) {
    const target =
      intent.kind === 'ENTRY'
        ? intent.candidate
        : this.state().positions.find((p) => p.id === intent.positionId);
    return target
      ? this.watch.monitored.get(marketKey(target.mint, target.poolAddress))
      : undefined;
  }
  async queueEntry(candidate: BuyCandidate, at: string) {
    if (
      this.checkpoint.pending.some(
        (p) => p.kind === 'ENTRY' && p.candidate.mint === candidate.mint,
      )
    ) {
      await this.record('ENTRY_SKIPPED', candidate.id, {
        signalId: candidate.id,
        reason: 'ACTIVE_ENTRY_INTENT',
      });
      return;
    }
    await this.queue({
      id: stableId([
        'forward-entry-intent-v1',
        this.definition.id,
        candidate.id,
      ]),
      kind: 'ENTRY',
      candidate,
      triggerAt: at,
      expiresAt: addMs(at, this.definition.policy.maxSignalAgeSeconds * 1000),
      quote: null,
    });
  }
  private async queue(intent: ForwardIntent) {
    if (this.checkpoint.pending.length >= 200)
      throw new Error('Forward intent capacity exceeded');
    this.checkpoint.pending.push(intent);
    await this.record('INTENT_OPENED', intent.id, { intent });
  }
  private async finish(
    intent: ForwardIntent,
    status: string,
    reasons: string[],
    orderId: string | null = null,
  ) {
    this.checkpoint.pending = this.checkpoint.pending.filter(
      (p) => p.id !== intent.id,
    );
    await this.record('INTENT_SETTLED', intent.id, {
      intent,
      status,
      reasons,
      orderId,
    });
  }
  async cancel(at: string, reason: string, entriesOnly = false) {
    for (const intent of [...this.checkpoint.pending]) {
      if (entriesOnly && intent.kind === 'EXIT') continue;
      if (intent.kind === 'EXIT') await this.blockExit(intent, at, reason);
      await this.finish(intent, 'CANCELLED', [reason]);
    }
  }
  private async blockExit(
    intent: Extract<ForwardIntent, { kind: 'EXIT' }>,
    at: string,
    reason: string,
  ) {
    await this.commit({
      type: 'EXIT_UNAVAILABLE',
      id: stableId(['forward-exit-unavailable-v1', intent.id, at]),
      at,
      positionId: intent.positionId,
      reason,
    });
  }
  async advance(at: string, canEnter: boolean) {
    for (const intent of [...this.checkpoint.pending]) {
      if (intent.kind === 'ENTRY' && !canEnter) {
        await this.finish(intent, 'CANCELLED', ['FORWARD_ENTRY_GATE_CLOSED']);
        continue;
      }
      if (intent.expiresAt <= at) {
        if (intent.kind === 'EXIT')
          await this.blockExit(intent, at, 'NO_FRESH_LANDING_OBSERVATION');
        await this.finish(intent, 'EXPIRED', ['NO_FRESH_LANDING_OBSERVATION']);
        continue;
      }
      const quoteDelay =
        this.execution.latency.processingMs + this.execution.latency.quoteMs;
      if (intent.quote || at < addMs(intent.triggerAt, quoteDelay)) continue;
      const pool = this.scope(intent)?.quote?.pool ?? null;
      const state = this.state(),
        cash = toAtomic(state.availableCashUsd),
        allocation =
          (toAtomic(state.equityUsd) *
            toAtomic(this.definition.policy.maxPositionPercent)) /
          toAtomic('100');
      const quantity =
        intent.kind === 'ENTRY'
          ? buyQuantity(
              pool,
              fromAtomic(cash < allocation ? cash : allocation),
              this.execution,
              this.definition.policy.quantityDecimals,
            )
          : intent.quantity;
      intent.quote = prepareQuote(
        pool,
        intent.kind === 'ENTRY' ? 'BUY' : 'SELL',
        quantity ?? '0.000000001',
        intent.triggerAt,
        at,
        addMs(at, latencyMs(this.execution) - quoteDelay),
        this.execution,
      );
      if (!quantity) intent.quote.error ??= 'NO_EXECUTABLE_QUOTE_SIZE';
      await this.record('QUOTE_PREPARED', intent.id, { quote: intent.quote });
    }
  }
  private context(
    intent: ForwardIntent,
    observation: ExecutionObservation,
  ): ExecutionContext {
    if (!intent.quote) throw new Error('Missing prepared execution quote');
    return {
      runId: this.definition.id,
      config: this.execution,
      quote: intent.quote,
      pool: observation.pool ?? null,
      nativeUsd: observation.nativeUsd ?? null,
      randomKey: `${observation.mint}:${intent.kind}:${intent.triggerAt}`,
    };
  }
  private canLand(
    intent: ForwardIntent,
    observation: ExecutionObservation,
    at: string,
  ) {
    return (
      !!intent.quote &&
      at > intent.triggerAt &&
      at >= intent.quote.dueAt &&
      at < intent.expiresAt &&
      observation.observedAt >= intent.quote.dueAt &&
      !!observation.pool &&
      observation.pool.observedAt >= intent.quote.dueAt
    );
  }
  private observationValid(observation: ExecutionObservation, at: string) {
    const pool = observation.pool;
    return (
      !!pool &&
      pool.baseMint === observation.mint &&
      pool.poolAddress === observation.poolAddress &&
      pool.availableAt <= at &&
      Date.parse(at) - Date.parse(pool.observedAt) <=
        this.execution.maxQuoteAgeMs &&
      !observationProblem(observation, this.definition.policy, at)
    );
  }
  quoteReady(observation: ExecutionObservation | null, at: string): boolean {
    if (
      !observation ||
      !this.observationValid(observation, at) ||
      !observation.pool
    )
      return false;
    try {
      validatePool(observation.pool);
      return (
        networkFees(this.execution, at, observation.nativeUsd ?? null)
          .unknown === 0n
      );
    } catch {
      return false;
    }
  }
  async observe(
    observation: ExecutionObservation,
    at: string,
    canEnter: boolean,
  ) {
    const market = this.watch.monitored.get(
      marketKey(observation.mint, observation.poolAddress),
    );
    if (!market) return;
    const valid = this.observationValid(observation, at);
    if (observation.side === 'BUY') {
      if (!canEnter || !valid || !this.watch.entryReady(market, at)) return;
      const intent = this.checkpoint.pending.find(
        (p) =>
          p.kind === 'ENTRY' &&
          p.candidate.mint === observation.mint &&
          p.candidate.poolAddress === observation.poolAddress,
      );
      if (
        !intent ||
        intent.kind !== 'ENTRY' ||
        !this.canLand(intent, observation, at)
      )
        return;
      const transition = await this.commit({
        type: 'ENTRY',
        id: stableId([
          'paper-entry-v1',
          this.definition.id,
          intent.candidate.id,
        ]),
        at,
        candidate: intent.candidate,
        risk: market.risk,
        observation,
        execution: this.context(intent, observation),
      });
      await this.finish(
        intent,
        transition.result.outcome === 'ENTRY_FILLED' ? 'FILLED' : 'FAILED',
        transition.result.reasons,
        transition.result.orderId,
      );
      return;
    }
    const position = this.state().positions.find(
      (p) =>
        p.mint === observation.mint &&
        p.poolAddress === observation.poolAddress &&
        p.status !== 'CLOSED',
    );
    if (
      !position ||
      (position.mark && position.mark.observedAt >= observation.observedAt)
    )
      return;
    const mark = valid
      ? executionMark(observation, position.quantity, this.execution)
      : null;
    const hadUnavailable = this.checkpoint.unavailable.includes(position.id);
    if (!mark && !hadUnavailable) this.checkpoint.unavailable.push(position.id);
    if (mark && hadUnavailable) {
      this.checkpoint.unavailable = this.checkpoint.unavailable.filter(
        (id) => id !== position.id,
      );
      delete this.checkpoint.failures[position.id];
    }
    const pending = this.checkpoint.pending.find(
      (p) => p.kind === 'EXIT' && p.positionId === position.id,
    );
    const critical =
      market.risk?.currentStatus === 'REJECTED' &&
      market.risk.assessment?.tokenMint === position.mint &&
      market.risk.currentRequestId === market.risk.assessment.requestId;
    const price = mark?.priceUsd ?? observation.priceUsd;
    const exit =
      valid && price
        ? chooseExit(position, price, at, this.definition.policy, critical)
        : null;
    const canExecute =
      !this.state().executionUncertain &&
      (this.checkpoint.failures[position.id] ?? 0) <
        this.execution.maxAttemptsPerPosition;
    const landing =
      canExecute &&
      pending?.kind === 'EXIT' &&
      exit?.reason === pending.reason &&
      exit.quantity === pending.quantity &&
      this.canLand(pending, observation, at);
    const markContext: ExecutionContext = {
      runId: this.definition.id,
      config: this.execution,
      quote: prepareQuote(
        valid ? (observation.pool ?? null) : null,
        'SELL',
        position.quantity,
        at,
        at,
        at,
        this.execution,
      ),
      pool: valid ? (observation.pool ?? null) : null,
      nativeUsd: observation.nativeUsd ?? null,
      randomKey: `mark:${observation.id}`,
    };
    const transition = await this.commit({
      type: 'MARK',
      id: stableId(['paper-mark-v1', this.definition.id, observation.id]),
      at,
      observation: valid ? observation : { ...observation, healthy: false },
      risk: market.risk,
      deferExecution: !landing,
      execution: landing ? this.context(pending, observation) : markContext,
    });
    if (landing && transition.orders.length) {
      const filled = transition.result.outcome === 'EXIT_FILLED';
      await this.finish(
        pending,
        filled ? 'FILLED' : 'FAILED',
        transition.result.reasons,
        transition.result.orderId,
      );
      if (filled) {
        delete this.checkpoint.failures[position.id];
        this.checkpoint.unavailable = this.checkpoint.unavailable.filter(
          (id) => id !== position.id,
        );
      } else
        this.checkpoint.failures[position.id] =
          (this.checkpoint.failures[position.id] ?? 0) + 1;
      return;
    }
    if (transition.result.outcome !== 'EXIT_SCHEDULED' || !canExecute) return;
    const updated = this.state().positions.find((p) => p.id === position.id)!;
    const reason = updated.pendingExitReason!,
      quantity = updated.pendingExitQuantity!;
    if (
      pending?.kind === 'EXIT' &&
      pending.reason === reason &&
      pending.quantity === quantity
    )
      return;
    if (pending)
      await this.finish(pending, 'SUPERSEDED', ['EXIT_CONDITION_CHANGED']);
    await this.queue({
      id: stableId([
        'forward-exit-intent-v1',
        position.id,
        observation.id,
        reason,
      ]),
      kind: 'EXIT',
      positionId: position.id,
      reason,
      quantity,
      triggerAt: at,
      expiresAt: addMs(at, 30000 + latencyMs(this.execution)),
      quote: null,
    });
  }
}
