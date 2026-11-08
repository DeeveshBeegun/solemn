/** Single-writer FIFO, bounded including the in-flight item; two reserved gap marker slots. */
export class IngestionQueue<T> {
  private readonly pending: T[] = [];
  private running = false;
  private accepting = true;
  private readonly abort = new AbortController();
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly capacity: number,
    private readonly process: (item: T, signal: AbortSignal) => Promise<void>,
    private readonly onFailure: (item: T, error: unknown) => void,
    private readonly onAbandoned: (items: T[]) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('Invalid queue capacity');
  }

  get depth(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }
  offer(item: T, control = false): boolean {
    if (!this.accepting || this.depth >= this.capacity + (control ? 2 : 0))
      return false;
    this.pending.push(item);
    void this.pump();
    return true;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const item = this.pending.shift();
        if (item === undefined) break;
        try {
          await this.process(item, this.abort.signal);
        } catch (error) {
          this.onFailure(item, error);
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  waitForIdle(): Promise<void> {
    if (this.depth === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  async stopAndDrain(timeoutMs: number): Promise<void> {
    this.accepting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.waitForIdle(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Ingestion drain deadline exceeded; accepted events may be lost',
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      this.abort.abort();
      this.onAbandoned(this.pending.splice(0));
      // An active SQL statement is bounded by the pool's statement timeout. Do not
      // close the pool while it is still being used by an accepted write.
      await this.waitForIdle();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
