import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { createPaperRepository, forwardOwnerPid } from '@solemn/database';
import type { Database } from '@solemn/database';
import type { PaperCommand } from '@solemn/shared';
import type { Config } from '../config/index.js';
import {
  forwardPortfolioId,
  lockForwardAccount,
  reliableEquity,
} from '../forward/account.js';
import { applyPaperCommand } from '../portfolio/portfolioManager.js';
import { assertPaperMode } from '../security/securityPolicy.js';
import { reconcileForwardLedger } from './portfolioReconciler.js';
import { engageKillSwitch, invalidatePendingEntries } from './killSwitch.js';
import {
  auditOperation,
  resolveIncidents,
  transitionOperations,
} from './operationalController.js';

export type AdministrativeAction = 'pause' | 'resume' | 'halt' | 'reset-halt';
export function operatorReason(reason: string | undefined, config: Config) {
  if (!reason?.trim() || reason.length > 160)
    throw new Error(
      'An explicit administrative reason of 1–160 characters is required',
    );
  const safe = reason.trim();
  const database = new URL(config.DATABASE_URL);
  const rpc = new URL(config.SOLANA_RPC_URL);
  for (const secret of [
    database.password,
    ...rpc.searchParams.values(),
    config.DATABASE_URL,
    config.JUPITER_API_KEY,
    config.PUMPPORTAL_API_KEY,
    config.SOLANA_RPC_URL,
  ])
    if (secret && safe.includes(secret))
      throw new Error('Administrative reason contains protected configuration');
  // Plain incident references only. This also excludes URLs, control characters and auth headers.
  if (!/^[A-Za-z0-9 .,_()-]{1,160}$/.test(safe))
    throw new Error('Administrative reason must be plain text');
  return safe;
}

export async function changeOperationalControl(
  db: Database,
  config: Config,
  action: AdministrativeAction,
  explanation?: string,
) {
  assertPaperMode(config);
  const id = forwardPortfolioId(config);
  const username = userInfo().username;
  const actor = /^[-\w.]{1,64}$/.test(username) ? username : 'local-operator';
  const reason =
    action === 'halt' || action === 'reset-halt'
      ? operatorReason(explanation, config)
      : undefined;
  return db.transaction(async (tx) => {
    let row = await lockForwardAccount(tx, id);
    const before = row.status,
      at = new Date().toISOString();
    if (action === 'halt')
      row = await engageKillSwitch(
        tx,
        row,
        'ADMINISTRATIVE_HALT',
        actor,
        'ADMIN',
      );
    else if (action === 'pause') {
      if (row.status === 'HALTED')
        throw new Error('HALTED must be reset explicitly');
      row = await transitionOperations(
        tx,
        row,
        'PAUSED',
        'ADMINISTRATIVE_PAUSE',
        actor,
        'ADMIN',
      );
      row = await invalidatePendingEntries(tx, row, 'ADMINISTRATIVE_PAUSE');
    } else {
      const reset = action === 'reset-halt';
      if (!reset && row.status === 'HALTED')
        throw new Error('HALTED requires an explicit reset');
      if (row.status !== (reset ? 'HALTED' : 'PAUSED'))
        throw new Error('Operation is invalid for the current state');
      const health = row.health;
      const healthFresh = (checkedAt: string) => {
        const age = Date.now() - Date.parse(checkedAt);
        return (
          age >= 0 &&
          age < config.OPERATIONS_HEALTH_CHECK_INTERVAL_SECONDS * 2000
        );
      };
      if (
        !row.ownerPid ||
        (await forwardOwnerPid(tx, id, row.ownerPid)) !== row.ownerPid ||
        !health ||
        health.market !== 'HEALTHY' ||
        health.database !== 'HEALTHY' ||
        !health.reconciledAt ||
        !healthFresh(health.checkedAt)
      )
        throw new Error(
          'Recovery requires an active owner and freshly verified market and database health',
        );
      const { definition, state } = await reconcileForwardLedger(tx, id);
      if (
        !healthFresh(health.checkedAt) ||
        (await forwardOwnerPid(tx, id, row.ownerPid)) !== row.ownerPid
      )
        throw new Error('Recovery evidence expired during reconciliation');
      const held = state.positions.some(
        (position) => position.status !== 'CLOSED',
      );
      if (
        !reliableEquity(state) ||
        (held && !health.protectiveExits) ||
        state.entryBlockReasons.includes('DAILY_LOSS_LIMIT') ||
        (!reset && state.status !== 'ACTIVE')
      )
        throw new Error(
          'Recovery requires resolved exposures, fresh marks and cleared risk constraints',
        );
      if (reset) {
        const key = randomUUID();
        await auditOperation(tx, row, {
          kind: 'HALT_RESET_REQUESTED',
          key,
          at,
          actor,
          source: 'ADMIN',
          reason: 'HALT_RESET_REQUESTED',
          severity: 'INFO',
          details: { explanation: reason },
        });
        if (state.status === 'HALTED') {
          const command: PaperCommand = {
            type: 'RESET_HALT',
            id: key,
            at: definition.dataMode === 'FORWARD_REPLAY' ? state.asOf : at,
            reason: 'OPERATIONAL_HALT_RESET',
          };
          const result = await createPaperRepository(tx).transact(
            id,
            command,
            (current, definition) =>
              applyPaperCommand(current, command, definition),
          );
          if (result.result.outcome !== 'RESET')
            throw new Error('Portfolio risk reset did not pass');
        }
        await resolveIncidents(tx, row, 'OPERATOR_VERIFIED_RECOVERY', actor);
      }
      row = await transitionOperations(
        tx,
        row,
        'RECOVERING',
        reset ? 'HALT_RESET_APPROVED' : 'ADMINISTRATIVE_RESUME',
        actor,
        'ADMIN',
      );
    }
    if (row.status !== before)
      await auditOperation(tx, row, {
        kind: 'ADMIN_CONTROL',
        key: String(row.opsVersion),
        reason: row.opsReason,
        actor,
        at,
        source: 'ADMIN',
        severity: row.status === 'HALTED' ? 'CRITICAL' : 'INFO',
        details: {
          action,
          previous: before,
          status: row.status,
          ...(reason ? { explanation: reason } : {}),
        },
      });
    return {
      portfolioId: id,
      action,
      state: row.status,
      version: row.opsVersion,
      reason: row.opsReason,
    };
  });
}
