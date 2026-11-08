import { stableHash } from '@solemn/shared';
import type { PaperRepository } from '@solemn/database';
import { initialPortfolio, initialPosting } from './accountingService.js';
import { applyPaperCommand } from './portfolioManager.js';
/** Replays the immutable command/posting journal, rather than trusting a mutable balance snapshot. */
export async function recoverPortfolio(
  repository: PaperRepository,
  portfolioId: string,
) {
  const snapshot = await repository.snapshot(portfolioId);
  const { events: history, ...account } = snapshot;
  if (!history.length) throw new Error('Missing portfolio ledger');
  let state = initialPortfolio(account.definition),
    previousHash: string | null = null;
  for (const [index, row] of history.entries()) {
    const { eventHash, ...fields } = row;
    if (
      row.sequence !== index + 1 ||
      row.previousHash !== previousHash ||
      eventHash !==
        stableHash({
          ...fields,
          timestamp: new Date(fields.timestamp).toISOString(),
        })
    )
      throw new Error('Portfolio ledger hash/sequence mismatch');
    if (index === 0) {
      if (
        row.command !== null ||
        stableHash(row.postings) !==
          stableHash([initialPosting(account.definition)]) ||
        stableHash(state) !== stableHash(row.stateAfter)
      )
        throw new Error('Invalid initial portfolio deposit');
    } else {
      if (!row.command || row.inputHash !== stableHash(row.command))
        throw new Error('Invalid ledger command');
      const replayed = applyPaperCommand(
        state,
        row.command,
        account.definition,
      );
      if (
        stableHash({
          state: replayed.state,
          postings: replayed.postings,
          orders: replayed.orders,
          result: replayed.result,
        }) !==
        stableHash({
          state: row.stateAfter,
          postings: row.postings,
          orders: row.orders,
          result: row.result,
        })
      )
        throw new Error('Portfolio history replay mismatch');
      state = replayed.state;
    }
    previousHash = eventHash;
  }
  if (stableHash(state) !== stableHash(account.state))
    throw new Error('Portfolio snapshot differs from reconstructed ledger');
  return { ...account, state, eventCount: history.length };
}
