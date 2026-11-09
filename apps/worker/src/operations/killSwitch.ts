import { eq } from 'drizzle-orm';
import { forwardAccounts, forwardRuntimeEvents } from '@solemn/database';
import type { Database } from '@solemn/database';
import { stableId } from '@solemn/shared';
import { replayCheckpointSchema } from '../forward/checkpoint.js';
import { openIncident, transitionOperations } from './operationalController.js';
import type { OperationAccount } from './operationalController.js';

/** Retain pending exits and every open position. Cancel only unfilled entry intents. */
export async function invalidatePendingEntries(
  db: Database,
  row: OperationAccount,
  reason: string,
) {
  if (row.mode !== 'REPLAY') return row;
  const parsed = replayCheckpointSchema.safeParse(row.checkpoint);
  // A corrupt checkpoint must never stop the kill switch from persisting.
  if (!parsed.success) return row;
  const checkpoint = parsed.data;
  const entries = checkpoint.pending.filter(
    (intent) => intent.kind === 'ENTRY',
  );
  if (!entries.length) return row;
  const at = checkpoint.cursor ?? entries[0]!.triggerAt;
  await db
    .insert(forwardRuntimeEvents)
    .values(
      entries.map((intent) => ({
        id: stableId([
          'forward-runtime-event-v1',
          row.portfolioId,
          'INTENT_SETTLED',
          intent.id,
        ]),
        portfolioId: row.portfolioId,
        sessionId: row.sessionId,
        kind: 'INTENT_SETTLED',
        at,
        details: {
          intent,
          status: 'CANCELLED',
          reasons: [reason],
          orderId: null,
        },
      })),
    )
    .onConflictDoNothing();
  const [updated] = await db
    .update(forwardAccounts)
    .set({
      checkpoint: {
        ...checkpoint,
        pending: checkpoint.pending.filter((intent) => intent.kind === 'EXIT'),
      },
    })
    .where(eq(forwardAccounts.portfolioId, row.portfolioId))
    .returning();
  if (!updated) throw new Error('Missing forward account');
  return updated;
}

export async function engageKillSwitch(
  db: Database,
  row: OperationAccount,
  reason: string,
  actor = 'worker',
  source: 'WORKER' | 'ADMIN' | 'OWNERSHIP' = 'WORKER',
) {
  const halted = await transitionOperations(
    db,
    row,
    'HALTED',
    reason,
    actor,
    source,
  );
  await openIncident(db, halted, reason, 'CRITICAL', actor, source);
  return invalidatePendingEntries(db, halted, reason);
}
