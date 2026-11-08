import {
  historicalFileSchema,
  compareHistoricalEvents,
  historicalManifestSchema,
} from '@solemn/shared';
import type {
  HistoricalEvent,
  HistoricalFile,
  StoredDataset,
} from '@solemn/shared';
import type { HistoryRepository } from '@solemn/database';
export interface HistoricalDataProvider {
  readonly dataset: StoredDataset;
  getEvents(params: {
    startTime: string;
    endTime: string;
    batchSize: number;
  }): AsyncIterable<HistoricalEvent>;
}
export async function* historyEvents(
  events: readonly HistoricalEvent[],
): AsyncIterable<HistoricalEvent> {
  for (const event of events) yield structuredClone(event);
}
export function validateHistoricalFile(input: unknown): HistoricalFile {
  const file = historicalFileSchema.parse(input);
  return {
    manifest: historicalManifestSchema.parse(file.manifest),
    events: [...file.events].sort(compareHistoricalEvents),
  };
}
export class PostgresHistoricalDataProvider implements HistoricalDataProvider {
  constructor(
    readonly dataset: StoredDataset,
    private readonly repository: HistoryRepository,
  ) {}
  getEvents(params: { startTime: string; endTime: string; batchSize: number }) {
    return this.repository.events(
      this.dataset.id,
      params.startTime,
      params.endTime,
      params.batchSize,
    );
  }
}
/** Bounded fixture source; the same event contract is used by paginated PostgreSQL replay. */
export class FixtureHistoricalDataProvider implements HistoricalDataProvider {
  private readonly events: HistoricalEvent[];
  constructor(
    readonly dataset: StoredDataset,
    input: unknown,
  ) {
    const file = validateHistoricalFile(input);
    this.events = file.events;
  }
  async *getEvents(params: {
    startTime: string;
    endTime: string;
    batchSize: number;
  }) {
    if (params.batchSize < 1 || params.batchSize > 1000)
      throw new Error('Invalid historical batch size');
    for (const event of this.events)
      if (
        Date.parse(event.availableAt) >= Date.parse(params.startTime) &&
        Date.parse(event.availableAt) <= Date.parse(params.endTime)
      )
        yield structuredClone(event);
  }
}
