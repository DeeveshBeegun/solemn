import { eq } from 'drizzle-orm';
import { createPaperRepository, forwardAccounts } from '@solemn/database';
import type { Database } from '@solemn/database';
import { toAtomic } from '@solemn/shared';
import type { PaperPortfolioState } from '@solemn/shared';
import { replayCheckpointSchema } from '../forward/checkpoint.js';
import { recoverPortfolio } from '../portfolio/recovery.js';
import type { OperationAccount } from './operationalController.js';

export function verifyForwardCheckpoint(
  row: OperationAccount,
  state: PaperPortfolioState,
) {
  if (row.mode !== 'REPLAY') return;
  const checkpoint = replayCheckpointSchema.parse(row.checkpoint);
  const intentIds = new Set<string>(),
    exits = new Set<string>();
  for (const intent of checkpoint.pending) {
    if (
      intentIds.has(intent.id) ||
      intent.expiresAt <= intent.triggerAt ||
      (checkpoint.cursor !== null && intent.triggerAt > checkpoint.cursor) ||
      (intent.quote &&
        intent.quote.side !== (intent.kind === 'ENTRY' ? 'BUY' : 'SELL'))
    )
      throw new Error('Forward pending intent does not reconcile');
    intentIds.add(intent.id);
    if (intent.kind === 'EXIT') {
      const position = state.positions.find((p) => p.id === intent.positionId);
      if (
        !position ||
        position.status === 'CLOSED' ||
        exits.has(position.id) ||
        toAtomic(intent.quantity) <= 0n ||
        toAtomic(intent.quantity) > toAtomic(position.quantity)
      )
        throw new Error('Pending exit quantity does not reconcile');
      exits.add(position.id);
    }
  }
}

export async function reconcileForwardLedger(db: Database, id: string) {
  return db.transaction(
    async (tx) => {
      const [row] = await tx
        .select()
        .from(forwardAccounts)
        .where(eq(forwardAccounts.portfolioId, id));
      if (!row) throw new Error('Unknown forward portfolio');
      const repository = createPaperRepository(tx);
      const snapshot = await repository.snapshot(id, {
        readOnly: true,
        maxEvents: 100000,
      });
      const recovered = await recoverPortfolio(repository, id, snapshot);
      verifyForwardCheckpoint(row, recovered.state);
      return {
        ...recovered,
        orders: snapshot.events.reduce(
          (count, event) => count + event.orders.length,
          0,
        ),
        fills: snapshot.events.reduce(
          (count, event) =>
            count +
            event.orders.reduce((sum, order) => sum + order.trades.length, 0),
          0,
        ),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
