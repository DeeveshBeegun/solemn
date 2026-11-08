import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { ScannerGap } from '@solemn/shared';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import type { Subscription } from './eventNormalizer.js';

export type ConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'STOPPING'
  | 'HALTED';
type GapReason = ScannerGap['reason'];
export interface TransportHandlers {
  open(): void;
  message(value: string, binary: boolean): void;
  close(code: number): void;
  error(): void;
  response(status: number): void;
  pong(): void;
}
export interface ScannerTransport {
  send(value: string): void;
  ping(): void;
  close(): void;
  terminate(): void;
}
export type TransportFactory = (
  url: string,
  handlers: TransportHandlers,
  config: Config,
) => ScannerTransport;

export const webSocketTransport: TransportFactory = (url, handlers, config) => {
  const socket = new WebSocket(url, {
    maxPayload: config.SCANNER_MAX_MESSAGE_BYTES,
    handshakeTimeout: config.SCANNER_CONNECT_TIMEOUT_MS,
    perMessageDeflate: false,
    followRedirects: false,
  });
  socket.on('open', handlers.open);
  socket.on('message', (data, binary) =>
    handlers.message(data.toString(), binary),
  );
  socket.on('close', (code) => handlers.close(code));
  socket.on('error', handlers.error);
  socket.on('pong', handlers.pong);
  socket.on('unexpected-response', (_request, response) => {
    handlers.response(response.statusCode ?? 0);
    response.resume();
    socket.terminate();
  });
  return {
    send: (value) =>
      socket.send(value, (error) => {
        if (error) {
          handlers.error();
          socket.terminate();
        }
      }),
    ping: () => socket.ping(),
    close: () => socket.close(1000),
    terminate: () => socket.terminate(),
  };
};

export interface ClientHooks {
  message(value: string, binary: boolean): void;
  gap(value: ScannerGap): void;
  reconnect(): void;
  canReconnect(): boolean;
}

export class PumpPortalClient {
  private state: ConnectionStatus = 'DISCONNECTED';
  private socket: ScannerTransport | undefined;
  private generation = 0;
  private stopped = false;
  private started = false;
  private retry = 0;
  private activeGap: ScannerGap | undefined;
  private readonly acknowledged = new Set<Subscription>();
  private readonly subscriptions: Subscription[];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionTimer: ReturnType<typeof setTimeout> | undefined;
  private subscriptionTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private stopPromise: Promise<void> | undefined;
  private closeDone: (() => void) | undefined;
  private disconnectReason: GapReason = 'DISCONNECTED';
  private halted = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly hooks: ClientHooks,
    private readonly factory: TransportFactory = webSocketTransport,
    private readonly random: () => number = Math.random,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.subscriptions = [
      ...(config.SCANNER_SUBSCRIBE_NEW_TOKENS
        ? ['subscribeNewToken' as const]
        : []),
      ...(config.SCANNER_SUBSCRIBE_MIGRATIONS
        ? ['subscribeMigration' as const]
        : []),
    ];
    if (this.subscriptions.length === 0)
      throw new Error('No scanner subscriptions configured');
  }

  get status(): ConnectionStatus {
    return this.state;
  }
  get subscriptionsReady(): boolean {
    return (
      this.state === 'CONNECTED' &&
      this.acknowledged.size === this.subscriptions.length
    );
  }
  private transition(next: ConnectionStatus): void {
    if (next === this.state) return;
    this.logger.info(
      { previous: this.state, status: next },
      'PumpPortal connection state changed',
    );
    this.state = next;
  }
  private beginGap(reason: GapReason, startedAt = this.now()): void {
    if (this.activeGap) {
      if (Date.parse(startedAt) < Date.parse(this.activeGap.startedAt)) {
        this.activeGap.startedAt = startedAt;
        this.hooks.gap({ ...this.activeGap });
      }
      return;
    }
    this.activeGap = {
      id: randomUUID(),
      source: 'PUMPPORTAL',
      startedAt,
      endedAt: null,
      reason,
    };
    this.logger.warn(this.activeGap, 'Scanner data gap started');
    this.hooks.gap({ ...this.activeGap });
  }
  private endGap(): void {
    if (!this.activeGap) return;
    const gap = { ...this.activeGap, endedAt: this.now() };
    this.activeGap = undefined;
    this.logger.info(
      gap,
      'Scanner data gap ended; missed events cannot be replayed automatically',
    );
    this.hooks.gap(gap);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.logger.info('Solemn scanner starting');
    this.beginGap('STARTUP');
    this.connect();
  }

  private clearConnectionTimers(): void {
    clearTimeout(this.connectionTimer);
    clearTimeout(this.subscriptionTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.pongTimer);
    clearInterval(this.heartbeatTimer);
    this.pongTimer = undefined;
  }

  private connect(): void {
    if (this.stopped || this.halted || this.socket) return;
    this.transition('CONNECTING');
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const url = new URL(this.config.PUMPPORTAL_WS_URL);
    if (this.config.PUMPPORTAL_API_KEY)
      url.searchParams.set('api-key', this.config.PUMPPORTAL_API_KEY);
    this.acknowledged.clear();
    this.disconnectReason = 'DISCONNECTED';
    const handlers: TransportHandlers = {
      open: () => {
        if (!current() || this.stopped) return;
        clearTimeout(this.connectionTimer);
        this.transition('CONNECTED');
        this.logger.info('PumpPortal WebSocket connected');
        try {
          for (const method of this.subscriptions)
            this.socket?.send(JSON.stringify({ method }));
        } catch {
          this.disconnect('CONNECTION_ERROR');
          return;
        }
        this.subscriptionTimer = setTimeout(
          () => this.disconnect('SUBSCRIPTION_TIMEOUT'),
          this.config.SCANNER_CONNECT_TIMEOUT_MS,
        );
        this.heartbeatTimer = setInterval(() => {
          if (this.pongTimer || this.stopped || !current()) return;
          this.pongTimer = setTimeout(
            () => this.disconnect('HEARTBEAT_TIMEOUT'),
            this.config.SCANNER_HEARTBEAT_TIMEOUT_MS,
          );
          try {
            this.socket?.ping();
          } catch {
            this.disconnect('CONNECTION_ERROR');
          }
        }, this.config.SCANNER_HEARTBEAT_INTERVAL_MS);
      },
      message: (value, binary) => {
        if (
          current() &&
          !this.stopped &&
          !this.halted &&
          this.state === 'CONNECTED'
        )
          this.hooks.message(value, binary);
      },
      pong: () => {
        if (current()) {
          clearTimeout(this.pongTimer);
          this.pongTimer = undefined;
        }
      },
      error: () => {
        if (!current() || this.stopped) return;
        this.logger.warn(
          'PumpPortal transport error (details suppressed to protect credentials)',
        );
        this.disconnect('CONNECTION_ERROR');
      },
      response: (status) => {
        if (current())
          this.disconnect(
            status === 401 || status === 403
              ? 'AUTHENTICATION_FAILED'
              : 'CONNECTION_ERROR',
            status === 401 || status === 403,
          );
      },
      close: (code) => {
        if (!current()) return;
        this.generation++;
        this.clearConnectionTimers();
        this.socket = undefined;
        this.logger.info(
          { closeCode: code },
          'PumpPortal WebSocket disconnected',
        );
        if (this.stopped) {
          this.transition('DISCONNECTED');
          this.closeDone?.();
        } else {
          this.beginGap(this.disconnectReason);
          if (this.halted) this.transition('HALTED');
          else this.scheduleReconnect();
        }
      },
    };
    try {
      this.socket = this.factory(url.toString(), handlers, this.config);
      this.connectionTimer = setTimeout(
        () => this.disconnect('CONNECTION_ERROR'),
        this.config.SCANNER_CONNECT_TIMEOUT_MS,
      );
    } catch {
      this.socket = undefined;
      this.beginGap('CONNECTION_ERROR');
      this.logger.warn('PumpPortal connection failed (details suppressed)');
      this.scheduleReconnect();
    }
  }

  acknowledge(subscription: Subscription): void {
    if (
      this.state !== 'CONNECTED' ||
      !this.subscriptions.includes(subscription)
    )
      return;
    if (!this.acknowledged.has(subscription))
      this.logger.info({ subscription }, 'PumpPortal subscription established');
    this.acknowledged.add(subscription);
    if (this.acknowledged.size !== this.subscriptions.length) return;
    clearTimeout(this.subscriptionTimer);
    this.endGap();
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.retry = 0;
    }, this.config.SCANNER_STABLE_CONNECTION_MS);
  }

  disconnect(reason: GapReason, halt = false, gapStartedAt?: string): void {
    if (this.stopped) return;
    if (halt)
      this.logger.error(
        { reason },
        'PumpPortal connection halted; check configuration before restarting',
      );
    this.disconnectReason = reason;
    this.halted ||= halt;
    this.beginGap(reason, gapStartedAt);
    if (this.socket) {
      // Stop acceptance immediately; terminate avoids a peer blocking backpressure recovery.
      this.transition(halt ? 'HALTED' : 'RECONNECTING');
      this.socket.terminate();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.halted || this.retryTimer) return;
    if (
      this.config.SCANNER_RECONNECT_MAX_ATTEMPTS > 0 &&
      this.retry >= this.config.SCANNER_RECONNECT_MAX_ATTEMPTS
    ) {
      this.halted = true;
      this.beginGap('RETRY_LIMIT');
      this.transition('HALTED');
      this.logger.error(
        'PumpPortal retry limit reached; restart after correcting the outage',
      );
      return;
    }
    const base = Math.min(
      this.config.SCANNER_RECONNECT_INITIAL_MS * 2 ** Math.min(this.retry, 30),
      this.config.SCANNER_RECONNECT_MAX_MS,
    );
    const delay = Math.floor(base * (0.5 + 0.5 * this.random()));
    this.transition('RECONNECTING');
    this.logger.info(
      { delayMs: delay, attempt: this.retry + 1 },
      'PumpPortal reconnection scheduled',
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stopped || this.halted) return;
      if (!this.hooks.canReconnect()) {
        this.scheduleReconnect();
        return;
      }
      this.retry++;
      this.hooks.reconnect();
      this.connect();
    }, delay);
  }

  stop(): Promise<void> {
    this.stopPromise ??= (async () => {
      this.stopped = true;
      this.beginGap('SHUTDOWN');
      this.transition('STOPPING');
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.clearConnectionTimers();
      if (this.socket) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.socket?.terminate();
            resolve();
          }, 1000);
          this.closeDone = () => {
            clearTimeout(timer);
            resolve();
          };
          try {
            this.socket?.close();
          } catch {
            this.socket?.terminate();
            this.closeDone();
          }
        });
      }
      this.generation++;
      this.socket = undefined;
      this.transition('DISCONNECTED');
    })();
    return this.stopPromise;
  }
}
