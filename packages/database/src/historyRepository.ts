import { and, eq, gte, lte, sql } from 'drizzle-orm';
import {
  analyzeHistory,
  historicalEventSchema,
  historicalManifestSchema,
  historicalSortKey,
  stableHash,
  stableId,
  storedDatasetSchema,
} from '@solemn/shared';
import type {
  HistoricalEvent,
  HistoricalManifest,
  StoredDataset,
} from '@solemn/shared';
import type { Database } from './client.js';
import { backtestDatasets, backtestDatasetEvents } from './backtestSchema.js';
export interface HistoryRepository {
  register(
    manifest: HistoricalManifest,
    events: AsyncIterable<HistoricalEvent>,
    batchSize: number,
    maxEvents: number,
  ): Promise<StoredDataset>;
  load(id: string): Promise<StoredDataset>;
  events(
    id: string,
    start: string,
    end: string,
    batchSize: number,
  ): AsyncIterable<HistoricalEvent>;
}
export function createHistoryRepository(db: Database): HistoryRepository {
  const load = async (id: string) => {
    const row = (
      await db
        .select()
        .from(backtestDatasets)
        .where(eq(backtestDatasets.id, id))
    )[0];
    if (!row || row.status !== 'READY')
      throw new Error('Historical dataset not found or not ready');
    return storedDatasetSchema.parse({
      id: row.id,
      fingerprint: row.fingerprint,
      manifest: row.manifest,
      quality: row.quality,
    });
  };
  return {
    load,
    async register(inputManifest, source, batchSize, maxEvents) {
      if (batchSize < 1 || batchSize > 1000)
        throw new Error('Invalid historical batch size');
      const manifest = historicalManifestSchema.parse(inputManifest),
        id = stableId([
          'historical-dataset-v1',
          manifest.datasetId,
          manifest.version,
        ]);
      return db.transaction(async (tx) => {
        await tx
          .insert(backtestDatasets)
          .values({
            id,
            sourceId: manifest.datasetId,
            version: manifest.version,
            status: 'IMPORTING',
            manifest,
          })
          .onConflictDoNothing();
        const existing = (
          await tx
            .select()
            .from(backtestDatasets)
            .where(eq(backtestDatasets.id, id))
            .for('update')
        )[0]!;
        if (stableHash(existing.manifest) !== stableHash(manifest))
          throw new Error('Dataset version is immutable; choose a new version');
        let batch: (typeof backtestDatasetEvents.$inferInsert)[] = [],
          count = 0,
          previousKey = '',
          previousHash = '';
        const flush = async () => {
          if (batch.length && existing.status !== 'READY')
            await tx.insert(backtestDatasetEvents).values(batch);
          batch = [];
        };
        async function* checked() {
          for await (const input of source) {
            if (++count > maxEvents)
              throw new Error('Dataset exceeds configured maximum event count');
            const event = historicalEventSchema.parse(input),
              sortKey = historicalSortKey(event),
              payloadHash = stableHash(event);
            if (sortKey < previousKey)
              throw new Error('Historical input is not canonically ordered');
            if (sortKey === previousKey) {
              if (payloadHash !== previousHash)
                throw new Error('Conflicting historical duplicate');
            } else {
              batch.push({
                datasetId: id,
                id: event.id,
                sortKey,
                availableAt: event.availableAt,
                eventAt: event.eventAt,
                kind: event.kind,
                mint: event.mint,
                poolAddress: event.poolAddress,
                payload: event,
                payloadHash,
              });
              if (batch.length >= batchSize) await flush();
            }
            previousKey = sortKey;
            previousHash = payloadHash;
            yield event;
          }
          await flush();
        }
        const analysis = await analyzeHistory(manifest, checked());
        if (existing.status === 'READY') {
          if (existing.fingerprint !== analysis.fingerprint)
            throw new Error('Dataset content changed without a version change');
          return storedDatasetSchema.parse({
            id,
            fingerprint: existing.fingerprint,
            manifest,
            quality: existing.quality,
          });
        }
        await tx
          .update(backtestDatasets)
          .set({ status: 'READY', ...analysis })
          .where(eq(backtestDatasets.id, id));
        return { id, manifest, ...analysis };
      });
    },
    async *events(id, start, end, batchSize) {
      if (batchSize < 1 || batchSize > 1000)
        throw new Error('Invalid historical batch size');
      let cursor = '';
      for (;;) {
        const rows = await db
          .select()
          .from(backtestDatasetEvents)
          .where(
            and(
              eq(backtestDatasetEvents.datasetId, id),
              sql`${backtestDatasetEvents.sortKey} COLLATE "C" > ${cursor}`,
              gte(backtestDatasetEvents.availableAt, start),
              lte(backtestDatasetEvents.availableAt, end),
            ),
          )
          .orderBy(sql`${backtestDatasetEvents.sortKey} COLLATE "C"`)
          .limit(batchSize);
        if (!rows.length) return;
        for (const row of rows) {
          const event = historicalEventSchema.parse(row.payload);
          if (
            stableHash(event) !== row.payloadHash ||
            historicalSortKey(event) !== row.sortKey
          )
            throw new Error('Historical stored event integrity mismatch');
          cursor = row.sortKey;
          yield event;
        }
      }
    },
  };
}
