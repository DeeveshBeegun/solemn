import type { ProviderErrorData } from '@solemn/shared';
import type { Config } from '../config/index.js';

export class ProviderError extends Error {
  constructor(readonly details: ProviderErrorData) {
    super(details.code);
  }
}
export function providerError(error: unknown): ProviderErrorData {
  return error instanceof ProviderError
    ? error.details
    : { code: 'NETWORK', httpStatus: null, retryAt: null };
}
const failure = (
  code: ProviderErrorData['code'],
  httpStatus: number | null = null,
  retryAt: string | null = null,
) => new ProviderError({ code, httpStatus, retryAt });
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(failure('ABORTED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Per-provider serialized requests, fixed spacing, bounded retries, no body/error logging. */
export class HttpReader {
  private tail = Promise.resolve();
  private pending = 0;
  private nextRequest = 0;
  constructor(
    private readonly config: Config,
    private readonly intervalMs: number,
    private readonly fetcher: typeof fetch = fetch,
    private readonly onRateLimit: () => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    acceptedErrorStatus?: number,
  ): Promise<{ body: string; receivedAt: string; httpStatus: number }> {
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw failure('ABORTED');
      try {
        return await this.attempt(url, init, signal, acceptedErrorStatus);
      } catch (error) {
        const details = providerError(error);
        if (
          attempt >= this.config.RISK_HTTP_MAX_ATTEMPTS ||
          !['TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'HTTP_ERROR'].includes(
            details.code,
          ) ||
          (details.code === 'HTTP_ERROR' && (details.httpStatus ?? 0) < 500)
        )
          throw error;
        const wait = Math.max(
          this.config.RISK_HTTP_RETRY_MS * 2 ** (attempt - 1),
          details.retryAt ? Date.parse(details.retryAt) - this.now() : 0,
        );
        if (wait > this.config.RISK_HTTP_MAX_BACKOFF_MS) throw error; // Do not retry before a provider's longer cooldown.
        try {
          await delay(wait, signal);
        } catch {
          throw failure('ABORTED');
        }
      }
    }
  }

  private async attempt(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    acceptedErrorStatus?: number,
  ): Promise<{ body: string; receivedAt: string; httpStatus: number }> {
    if (this.pending >= 64) throw failure('CLIENT_BUSY');
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending++;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      await previous;
      if (signal.aborted) throw failure('ABORTED');
      const wait = Math.max(0, this.nextRequest - this.now());
      if (wait > this.config.RISK_HTTP_MAX_BACKOFF_MS)
        throw failure(
          'RATE_LIMITED',
          429,
          new Date(this.nextRequest).toISOString(),
        );
      await delay(wait, signal);
      this.nextRequest = this.now() + this.intervalMs;
      timeout = setTimeout(
        () => controller.abort(),
        this.config.RISK_HTTP_TIMEOUT_MS,
      );
      const response = await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([signal, controller.signal]),
      });
      if (response.status === 429) {
        this.onRateLimit();
        const retry = response.headers.get('retry-after');
        const reset = response.headers.get('x-ratelimit-reset');
        const retryMs =
          retry && /^\d+(?:\.\d+)?$/.test(retry)
            ? this.now() + Number(retry) * 1000
            : retry
              ? Date.parse(retry)
              : 0;
        const resetMs =
          reset && /^\d+(?:\.\d+)?$/.test(reset) ? Number(reset) * 1000 : 0;
        const resume = Math.min(
          this.now() + 86400000,
          Math.max(
            this.now() + this.intervalMs,
            Number.isFinite(retryMs) ? retryMs : 0,
            Number.isFinite(resetMs) ? resetMs : 0,
          ),
        );
        this.nextRequest = Math.max(this.nextRequest, resume);
        await response.body?.cancel();
        throw failure('RATE_LIMITED', 429, new Date(resume).toISOString());
      }
      if (!response.ok && response.status !== acceptedErrorStatus) {
        await response.body?.cancel();
        throw failure(
          [401, 403].includes(response.status)
            ? 'AUTHENTICATION'
            : 'HTTP_ERROR',
          response.status,
        );
      }
      if (!response.body) throw failure('INVALID_RESPONSE');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw failure('INVALID_RESPONSE');
        }
        chunks.push(chunk.value);
      }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      return {
        body,
        receivedAt: new Date(this.now()).toISOString(),
        httpStatus: response.status,
      };
    } catch (error) {
      if (signal.aborted) throw failure('ABORTED');
      if (controller.signal.aborted) throw failure('TIMEOUT');
      if (error instanceof ProviderError) throw error;
      throw failure('NETWORK');
    } finally {
      clearTimeout(timeout);
      this.pending--;
      release();
    }
  }
}
