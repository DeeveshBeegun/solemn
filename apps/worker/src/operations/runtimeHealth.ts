import type { Database, OperationalHealth } from '@solemn/database';
import type { PaperPortfolioState } from '@solemn/shared';
import { engageKillSwitch } from './killSwitch.js';
import {
  openIncident,
  resolveIncidents,
  runtimeState,
  setOperationalHealth,
  transitionOperations,
} from './operationalController.js';
import type { OperationAccount } from './operationalController.js';

export function riskHaltReason(
  state: PaperPortfolioState,
  reliable: boolean,
): string | null {
  if (state.executionUncertain) return 'PAPER_EXECUTION_UNCERTAIN';
  if (state.status === 'HALTED')
    return state.haltReason === 'TOTAL_DRAWDOWN_LIMIT'
      ? state.haltReason
      : 'PAPER_PORTFOLIO_HALTED';
  return reliable && state.entryBlockReasons.includes('DAILY_LOSS_LIMIT')
    ? 'DAILY_LOSS_LIMIT'
    : null;
}

export async function updateRuntimeHealth(
  db: Database,
  row: OperationAccount,
  state: PaperPortfolioState,
  health: Omit<OperationalHealth, 'impairedSince'>,
  outageMs: number,
  reliableEquity: boolean,
) {
  const impairment = ['STALE', 'DISCONNECTED', 'OVERLOADED'].includes(
    health.market,
  );
  const priorMarket = row.health?.market;
  const impairedSince = impairment
    ? (row.health?.impairedSince ?? health.sourceAt)
    : null;
  row = await setOperationalHealth(db, row, { ...health, impairedSince });
  const risk = riskHaltReason(state, reliableEquity);
  if (risk) row = await engageKillSwitch(db, row, risk);
  if (
    impairedSince &&
    Date.parse(health.sourceAt) - Date.parse(impairedSince) >= outageMs
  )
    await openIncident(db, row, 'MARKET_DATA_OUTAGE', 'WARNING');
  if (health.market === 'HEALTHY' && priorMarket !== 'HEALTHY')
    await resolveIncidents(
      db,
      row,
      'VALID_MARKET_WINDOW_RESTORED',
      'worker',
      'MARKET_DATA_OUTAGE',
    );
  if (state.positions.some((position) => position.status === 'EXIT_BLOCKED'))
    await openIncident(db, row, 'UNRESOLVED_PROTECTIVE_EXIT', 'CRITICAL');
  else
    await resolveIncidents(
      db,
      row,
      'NO_BLOCKED_EXIT_REMAINS',
      'worker',
      'UNRESOLVED_PROTECTIVE_EXIT',
    );
  const ready =
    health.market === 'HEALTHY' &&
    health.database === 'HEALTHY' &&
    health.reconciledAt !== null &&
    reliableEquity &&
    state.status === 'ACTIVE';
  return transitionOperations(
    db,
    row,
    runtimeState(row.status, ready ? 'RUNNING' : 'DEGRADED'),
    ready
      ? 'HEALTH_CHECKS_PASSED'
      : health.market === 'HEALTHY'
        ? 'PORTFOLIO_NOT_READY'
        : health.reason,
    'worker',
    'WORKER',
  );
}
