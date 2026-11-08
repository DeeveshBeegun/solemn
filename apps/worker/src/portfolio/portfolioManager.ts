import {
  fromAtomic,
  paperCommandSchema,
  paperOrderRecordSchema,
  stableId,
  toAtomic,
} from '@solemn/shared';
import type {
  ExecutionObservation,
  PaperAccountDefinition,
  PaperActionResult,
  PaperCommand,
  PaperOrderRecord,
  PaperPortfolioState,
  PaperPosition,
  PaperPosting,
  PaperTransition,
} from '@solemn/shared';
import {
  PaperExecutor,
  executionPrice,
  observationProblem,
} from '../execution/paperExecutor.js';
import { entryRiskReasons } from '../risk/riskManager.js';
import { sizePosition } from '../risk/positionSizing.js';
import { applyPosting, reconcilePortfolio } from './accountingService.js';
import {
  applyExitFill,
  chooseExit,
  updatePositionMark,
} from './positionManager.js';

export function applyPaperCommand(
  previous: PaperPortfolioState,
  input: PaperCommand,
  definition: PaperAccountDefinition,
): PaperTransition {
  const command = paperCommandSchema.parse(input),
    state = structuredClone(previous);
  const postings: PaperPosting[] = [],
    orders: PaperOrderRecord[] = [];
  const done = (
    outcome: PaperActionResult['outcome'],
    reasons: string[],
    orderId: string | null = null,
    positionId: string | null = null,
  ): PaperTransition => {
    reconcilePortfolio(state, definition, state.asOf);
    return {
      state,
      postings,
      orders,
      result: { outcome, reasons, orderId, positionId },
    };
  };
  const post = (posting: PaperPosting) => {
    applyPosting(state, posting);
    postings.push(posting);
  };
  const cashPosting = (
    type: PaperPosting['type'],
    available: bigint,
    reserved = 0n,
    realized = 0n,
    buyFee = 0n,
    sellFee = 0n,
  ): PaperPosting => ({
    type,
    availableDeltaUsd: fromAtomic(available),
    reservedDeltaUsd: fromAtomic(reserved),
    realizedDeltaUsd: fromAtomic(realized),
    buyFeesDeltaUsd: fromAtomic(buyFee),
    sellFeesDeltaUsd: fromAtomic(sellFee),
  });
  if (Date.parse(command.at) < Date.parse(previous.asOf))
    return done(command.type === 'ENTRY' ? 'ENTRY_REJECTED' : 'STALE_DATA', [
      'COMMAND_OUT_OF_ORDER',
    ]);
  reconcilePortfolio(state, definition, command.at);
  if (command.type === 'HALT') {
    state.status = 'HALTED';
    state.haltReason = command.reason;
    return done('HALTED', [command.reason]);
  }
  if (command.type === 'RESET_HALT') {
    if (
      state.positions.some(
        (position) =>
          position.status !== 'CLOSED' &&
          (position.valuationStale ||
            position.liquidationUncertain ||
            position.status === 'EXIT_BLOCKED'),
      )
    )
      return done('ENTRY_REJECTED', [
        'RESET_REQUIRES_RESOLVED_POSITIONS_AND_FRESH_MARKS',
      ]);
    state.status = 'ACTIVE';
    state.haltReason = null;
    state.peakEquityUsd = state.equityUsd;
    state.dayStartingEquityUsd = state.equityUsd;
    return done('RESET', ['ADMINISTRATIVE_RESET', command.reason]);
  }
  if (command.type === 'EXIT_UNAVAILABLE') {
    const position = state.positions.find(
      (item) => item.id === command.positionId && item.status !== 'CLOSED',
    );
    if (!position) return done('NO_POSITION', ['NO_OPEN_POSITION']);
    position.status = 'EXIT_BLOCKED';
    position.blockedReason = command.reason;
    return done('EXIT_FAILED', [command.reason], null, position.id);
  }
  if (command.type === 'TICK')
    return done(
      state.status === 'HALTED' ? 'HALTED' : 'STALE_DATA',
      state.entryBlockReasons.length
        ? state.entryBlockReasons
        : ['NO_EXECUTION_OBSERVATION'],
    );
  if (command.type === 'ENTRY') {
    const candidate = command.candidate;
    if (command.id !== stableId(['paper-entry-v1', state.id, candidate.id]))
      return done('ENTRY_REJECTED', ['ENTRY_IDENTITY_MISMATCH']);
    const reasons = entryRiskReasons(command, state, definition);
    const problem = observationProblem(
      command.observation,
      definition.policy,
      command.at,
      candidate.mint,
      candidate.poolAddress,
      'BUY',
    );
    if (problem) reasons.push(problem);
    if (
      command.observation?.liquidityUsd === null ||
      !command.observation ||
      toAtomic(command.observation.liquidityUsd) <= 0n
    )
      reasons.push('LIQUIDITY_UNAVAILABLE');
    if (reasons.length) return done('ENTRY_REJECTED', [...new Set(reasons)]);
    const observation = command.observation as ExecutionObservation,
      price = executionPrice(observation, definition.policy);
    if (!price) return done('ENTRY_REJECTED', ['INVALID_EXECUTION_PRICE']);
    const size = sizePosition(
      state.equityUsd,
      state.availableCashUsd,
      price,
      definition.policy,
    );
    if (!size) return done('ENTRY_REJECTED', ['NO_VALID_POSITION_SIZE']);
    const reserve = toAtomic(size.totalCostUsd),
      positionId = stableId(['paper-position-v1', state.id, candidate.id]);
    post(cashPosting('RESERVE', -reserve, reserve));
    const request = {
      orderId: stableId(['paper-entry-order-v1', state.id, candidate.id]),
      tokenMint: candidate.mint,
      side: 'BUY' as const,
      executionMode: 'PAPER' as const,
      quantity: size.quantity,
    };
    const execution = new PaperExecutor().simulate(
      request,
      observation,
      definition.policy,
      command.at,
      { availableCashUsd: size.totalCostUsd, tokenBalance: '0' },
    );
    const record = paperOrderRecordSchema.parse({
      ...execution,
      request,
      positionId,
      signalId: candidate.id,
      reason: 'STRATEGY_ENTRY',
      observation,
      assumptions: definition.policy,
    });
    orders.push(record);
    if (execution.order.status !== 'FILLED') {
      post(cashPosting('RELEASE', reserve, -reserve));
      return done(
        'ENTRY_REJECTED',
        [execution.failureReason as string],
        request.orderId,
      );
    }
    const fill = execution.trades[0]!,
      fee = toAtomic(fill.feesUsd),
      totalCost = toAtomic(execution.notionalUsd) + fee;
    post(cashPosting('BUY_FILL', reserve - totalCost, -reserve, 0n, fee));
    const position: PaperPosition = {
      id: positionId,
      portfolioId: state.id,
      mint: candidate.mint,
      poolAddress: candidate.poolAddress,
      status: 'OPEN',
      signalId: candidate.id,
      originalQuantity: fill.executedQuantity,
      quantity: fill.executedQuantity,
      entryPriceUsd: fill.executionPriceUsd,
      initialCostBasisUsd: fromAtomic(totalCost),
      costBasisUsd: fromAtomic(totalCost),
      realizedPnlUsd: '0',
      unrealizedPnlUsd: fromAtomic(-fee),
      feesUsd: fill.feesUsd,
      openedAt: command.at,
      closedAt: null,
      mark: null,
      markValueUsd: execution.notionalUsd,
      valuationStale: true,
      liquidationUncertain: true,
      highestSellPriceUsd: null,
      trailingPeakUsd: null,
      target1Complete: false,
      target2Complete: false,
      blockedReason: null,
      pendingExitReason: null,
      pendingExitQuantity: null,
    };
    state.positions.push(position);
    return done(
      'ENTRY_FILLED',
      ['PAPER_BUY_FILLED'],
      request.orderId,
      positionId,
    );
  }
  const observation = command.observation;
  if (command.id !== stableId(['paper-mark-v1', state.id, observation.id]))
    return done('STALE_DATA', ['MARK_IDENTITY_MISMATCH']);
  const position = state.positions.find(
    (item) =>
      item.status !== 'CLOSED' &&
      item.mint === observation.mint &&
      item.poolAddress === observation.poolAddress,
  );
  if (!position) return done('NO_POSITION', ['NO_OPEN_POSITION']);
  const problem = observationProblem(
    observation,
    definition.policy,
    command.at,
    position.mint,
    position.poolAddress,
    'SELL',
  );
  if (
    problem ||
    (position.mark &&
      Date.parse(observation.observedAt) <=
        Date.parse(position.mark.observedAt))
  ) {
    position.valuationStale = true;
    position.liquidationUncertain = true;
    return done(
      'STALE_DATA',
      [problem ?? 'MARK_OUT_OF_ORDER'],
      null,
      position.id,
    );
  }
  const price = executionPrice(observation, definition.policy);
  if (!price) {
    position.valuationStale = true;
    return done('STALE_DATA', ['INVALID_EXECUTION_PRICE'], null, position.id);
  }
  updatePositionMark(position, observation, definition.policy);
  // UNKNOWN/stale risk blocks entry; known current REJECTED evidence also requests a protective exit.
  const criticalRisk =
    command.risk?.currentStatus === 'REJECTED' &&
    command.risk.assessment?.tokenMint === position.mint &&
    command.risk.currentRequestId === command.risk.assessment.requestId &&
    Date.parse(command.risk.availableAt) <= Date.parse(command.at);
  const exit = chooseExit(
    position,
    price,
    command.at,
    definition.policy,
    criticalRisk,
  );
  if (!exit)
    return done('MARK_UPDATED', ['SELL_SIDE_MARK_UPDATED'], null, position.id);
  if (toAtomic(exit.quantity) === 0n) {
    position.status = 'EXIT_BLOCKED';
    position.blockedReason = 'TARGET_QUANTITY_BELOW_PRECISION';
    return done(
      'EXIT_FAILED',
      [exit.reason, position.blockedReason],
      null,
      position.id,
    );
  }
  if (command.deferExecution) {
    position.pendingExitReason = exit.reason;
    position.pendingExitQuantity = exit.quantity;
    return done('EXIT_SCHEDULED', [exit.reason], null, position.id);
  }
  const request = {
    orderId: stableId([
      'paper-exit-order-v1',
      state.id,
      position.id,
      command.id,
      exit.reason,
    ]),
    tokenMint: position.mint,
    side: 'SELL' as const,
    executionMode: 'PAPER' as const,
    quantity: exit.quantity,
  };
  const execution = new PaperExecutor().simulate(
    request,
    observation,
    definition.policy,
    command.at,
    {
      availableCashUsd: state.availableCashUsd,
      tokenBalance: position.quantity,
    },
  );
  orders.push(
    paperOrderRecordSchema.parse({
      ...execution,
      request,
      positionId: position.id,
      signalId: null,
      reason: exit.reason,
      observation,
      assumptions: definition.policy,
    }),
  );
  if (execution.order.status !== 'FILLED') {
    position.status = 'EXIT_BLOCKED';
    position.blockedReason = execution.failureReason;
    position.pendingExitReason = exit.reason;
    position.pendingExitQuantity = exit.quantity;
    return done(
      'EXIT_FAILED',
      [exit.reason, execution.failureReason as string],
      request.orderId,
      position.id,
    );
  }
  const fill = execution.trades[0]!,
    fee = toAtomic(fill.feesUsd),
    netProceeds = toAtomic(execution.notionalUsd) - fee;
  const realized = applyExitFill(
    position,
    fill.executedQuantity,
    netProceeds,
    fee,
    exit.reason,
    command.at,
    price,
  );
  post(cashPosting('SELL_FILL', netProceeds, 0n, realized, 0n, fee));
  if (position.status !== 'CLOSED')
    updatePositionMark(position, observation, definition.policy);
  return done(
    'EXIT_FILLED',
    [
      exit.reason,
      position.status === 'CLOSED'
        ? 'POSITION_CLOSED'
        : 'PARTIAL_POSITION_EXIT',
    ],
    request.orderId,
    position.id,
  );
}
