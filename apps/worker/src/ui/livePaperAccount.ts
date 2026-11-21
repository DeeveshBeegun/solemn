import { desc, eq, sql } from 'drizzle-orm';
import {
  paperPortfolios,
  portfolioBalanceEvents,
  trades,
} from '@solemn/database';
import { loadConfig } from '../config/index.js';
import { freePaperProfile } from '../portfolio/freePaperDecisions.js';
import { readDatabase } from './dataExplorer.js';

export async function readLivePaperAccount(workerRunning: boolean) {
  const config = loadConfig(process.env);
  const profile = freePaperProfile(config, new Date().toISOString());
  return readDatabase(async (db) => {
    const row = (
      await db
        .select()
        .from(paperPortfolios)
        .where(eq(paperPortfolios.id, profile.definition.id))
        .limit(1)
    )[0];
    if (!row)
      return {
        database: 'ready',
        account: {
          name: profile.definition.name,
          status: 'NOT_INITIALIZED',
          workerRunning,
          events: [],
        },
      };
    const counts = (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(trades)
        .where(eq(trades.portfolioId, row.id))
    )[0];
    const events = await db
      .select()
      .from(portfolioBalanceEvents)
      .where(eq(portfolioBalanceEvents.portfolioId, row.id))
      .orderBy(desc(portfolioBalanceEvents.sequence))
      .limit(40);
    const state = row.state,
      open = state.positions.filter((p) => p.status !== 'CLOSED');
    return {
      database: 'ready',
      account: {
        name: row.name,
        portfolioId: row.id,
        status: state.status,
        workerRunning,
        executionModel: row.definition.freeExecution?.model ?? 'DECISIONS_ONLY',
        markedEquityUsd: state.equityUsd,
        availableCashUsd: state.availableCashUsd,
        buyFeesUsd: state.buyFeesUsd,
        sellFeesUsd: state.sellFeesUsd,
        trackedTokens: new Set(state.positions.map((p) => p.mint)).size,
        openPositions: open.length,
        fills: counts?.n ?? 0,
        valuationQuality: open.some(
          (p) =>
            p.valuationStale ||
            p.liquidationUncertain ||
            !p.mark ||
            Date.now() - Date.parse(p.mark.observedAt) >
              row.definition.policy.maxPriceAgeSeconds * 1000,
        )
          ? 'UNCERTAIN'
          : 'MODELED',
        feedHealth: 'FREE_PUBLIC_DATA',
        events: events.map((e) => ({
          at: e.timestamp,
          kind: e.result.outcome,
          level: 'info',
          facts: { reason: e.result.reasons.join(',') },
        })),
      },
    };
  });
}
