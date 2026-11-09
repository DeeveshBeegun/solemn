import { idSchema, stableHash } from '@solemn/shared';
import type { PaperOrderRecord } from '@solemn/shared';
import type { PaperRepository } from '@solemn/database';
import { initialPortfolio, initialPosting } from './accountingService.js';
import { applyPaperCommand } from './portfolioManager.js';

function legacyAuditReferences(
  replayed: PaperOrderRecord,
  stored: PaperOrderRecord | undefined,
): PaperOrderRecord {
  const audit = replayed.audit;
  const legacy = stored?.audit;
  if (
    !audit ||
    !legacy ||
    legacy.modelVersion !== 'SOLEMN_EXECUTION_V1' ||
    legacy.context.config.revision !== undefined ||
    legacy.context.pool?.quality !== 'SYNTHETIC' ||
    Object.hasOwn(legacy, 'signalId') ||
    Object.hasOwn(legacy, 'positionId')
  )
    return replayed;
  const comparable = { ...audit };
  delete comparable.signalId;
  delete comparable.positionId;
  // Early synthetic executions used an opaque post-swap snapshot ID.
  // Keep validating the entire pool, reserves, amounts and fees against replay.
  if (
    comparable.updatedPool &&
    legacy.updatedPool &&
    idSchema.safeParse(legacy.updatedPool.id).success
  )
    comparable.updatedPool = {
      ...comparable.updatedPool,
      id: legacy.updatedPool.id,
    };
  return { ...replayed, audit: comparable };
}
/** Replays the immutable command/posting journal, rather than trusting a mutable balance snapshot. */
export async function recoverPortfolio(
  repository: PaperRepository,
  portfolioId: string,
  loaded?: Awaited<ReturnType<PaperRepository['snapshot']>>,
) {
  const snapshot = loaded ?? (await repository.snapshot(portfolioId));
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
      const recorded = stableHash({
        state: row.stateAfter,
        postings: row.postings,
        orders: row.orders,
        result: row.result,
      });
      if (
        stableHash(replayed) !== recorded &&
        (account.definition.dataMode !== 'FIXTURE' ||
          stableHash({
            ...replayed,
            orders: replayed.orders.map((order, index) =>
              legacyAuditReferences(order, row.orders[index]),
            ),
          }) !== recorded)
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
