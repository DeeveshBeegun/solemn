import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestionQueue } from '../src/scanner/ingestionQueue.js';
import {
  createCounters,
  createEventProcessor,
} from '../src/scanner/eventProcessor.js';
import { loadConfig } from '../src/config/index.js';
import { normalizeMessage } from '../src/scanner/eventNormalizer.js';
import { launchRaw, NOW } from './scannerFixtures.js';

afterEach(() => vi.useRealTimers());
describe('bounded ingestion queue and retries', () => {
  it('bounds depth, preserves FIFO order and drains accepted items', async () => {
    let release: (() => void) | undefined;
    const processed: number[] = [];
    const queue = new IngestionQueue<number>(
      2,
      async (item) => {
        processed.push(item);
        if (item === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
      vi.fn(),
      vi.fn(),
    );
    expect(queue.offer(1)).toBe(true);
    expect(queue.offer(2)).toBe(true);
    expect(queue.offer(3)).toBe(false);
    expect(queue.depth).toBe(2);
    const draining = queue.stopAndDrain(1000);
    expect(queue.offer(4)).toBe(false);
    release?.();
    await draining;
    expect(processed).toEqual([1, 2]);
    expect(queue.depth).toBe(0);
  });
  it('reports failures and continues draining without an unhandled rejection', async () => {
    const failed = vi.fn();
    const queue = new IngestionQueue<number>(
      2,
      async () => {
        throw new Error('write failed');
      },
      failed,
      vi.fn(),
    );
    queue.offer(1);
    await queue.stopAndDrain(1000);
    expect(failed).toHaveBeenCalledOnce();
  });
  it('aborts retries and reports abandoned accepted items on drain timeout', async () => {
    vi.useFakeTimers();
    const abandoned = vi.fn();
    const queue = new IngestionQueue<number>(
      2,
      async (_item, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
      vi.fn(),
      abandoned,
    );
    queue.offer(1);
    queue.offer(2);
    const result = queue.stopAndDrain(10).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBeInstanceOf(Error);
    expect(abandoned).toHaveBeenCalledWith([2]);
    expect(queue.depth).toBe(0);
  });
  it('retries transient failures with a bound, but never retries integrity failures', async () => {
    vi.useFakeTimers();
    const parsed = normalizeMessage(launchRaw, NOW);
    if (parsed.kind !== 'event') throw new Error('Expected fixture');
    const repository = {
      persistEvent: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('offline'), { code: 'ECONNRESET' }),
        )
        .mockResolvedValue('INSERTED'),
      recordGap: vi.fn(),
    };
    const counters = createCounters();
    const process = createEventProcessor(
      repository,
      loadConfig({
        DATABASE_URL: 'postgresql://localhost/solemn',
        SCANNER_DB_RETRY_MS: '10',
      }),
      pino({ level: 'silent' }),
      counters,
    );
    const pending = process(
      { kind: 'event', value: parsed.value },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(repository.persistEvent).toHaveBeenCalledTimes(2);
    expect(counters.failedWrites).toBe(1);
    expect(counters.successfulWrites).toBe(1);
    repository.persistEvent.mockRejectedValue(
      Object.assign(new Error('integrity'), { code: '23503' }),
    );
    await expect(
      process(
        { kind: 'event', value: parsed.value },
        new AbortController().signal,
      ),
    ).rejects.toThrow('integrity');
    expect(repository.persistEvent).toHaveBeenCalledTimes(3);
  });
});
