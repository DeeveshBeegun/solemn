import { eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { swapExecutionAssessments as assessments } from './swapAuditSchema.js';

export type SwapAuditRow = typeof assessments.$inferSelect;

export function createSwapAuditRepository(db: Database) {
  const find = async (id: string): Promise<SwapAuditRow | null> =>
    (await db.select().from(assessments).where(eq(assessments.id, id)))[0] ??
    null;
  return {
    find,
    async save(row: SwapAuditRow): Promise<SwapAuditRow> {
      const inserted = (
        await db
          .insert(assessments)
          .values(row)
          .onConflictDoNothing()
          .returning()
      )[0];
      const stored = inserted ?? (await find(row.id));
      if (!stored || stored.fingerprint !== row.fingerprint)
        throw new Error('Swap audit identifier conflicts with another request');
      return stored;
    },
  };
}
