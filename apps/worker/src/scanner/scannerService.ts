import type { ScannerRepository } from '@solemn/database';
import type { ScannerEvent } from '@solemn/shared';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { safeError } from '../services/logger.js';
import { normalizeMessage } from './eventNormalizer.js';
import { createCounters, createEventProcessor } from './eventProcessor.js';
import type { IngestionItem } from './eventProcessor.js';
import { IngestionQueue } from './ingestionQueue.js';
import { PumpPortalClient } from './pumpPortalClient.js';
import type { TransportFactory } from './pumpPortalClient.js';

export function createScannerService(
  config: Config,
  repository: ScannerRepository,
  logger: Logger,
  factory?: TransportFactory,
  onPersisted?: (event: ScannerEvent) => void,
) {
  const counters = createCounters();
  let stopping = false;
  let started = false;
  let lostAcceptedEvents = false;
  let shutdown: Promise<void> | undefined;
  let metricsTimer: ReturnType<typeof setInterval> | undefined;
  const processor = createEventProcessor(
    repository,
    config,
    logger,
    counters,
    onPersisted,
  );
  const queue = new IngestionQueue<IngestionItem>(
    config.SCANNER_QUEUE_CAPACITY,
    processor,
    (item, error) => {
      logger.error(
        {
          ...safeError(error),
          itemKind: item.kind,
          eventId: item.kind === 'event' ? item.value.event.id : item.value.id,
        },
        'Scanner persistence exhausted retries; possible data loss',
      );
      lostAcceptedEvents = true;
      if (item.kind === 'event') counters.droppedEvents++;
      client.disconnect(
        'PERSISTENCE_FAILED',
        false,
        item.kind === 'event'
          ? item.value.event.ingestedAt
          : item.value.startedAt,
      );
    },
    (items) => {
      lostAcceptedEvents = true;
      const count = items.filter((item) => item.kind === 'event').length;
      counters.droppedEvents += count;
      logger.error(
        { abandonedEvents: count, abandonedGapMarkers: items.length - count },
        'Scanner drain deadline: accepted items abandoned; possible data loss',
      );
    },
  );
  const client = new PumpPortalClient(
    config,
    logger,
    {
      message(raw, binary) {
        if (stopping) return;
        counters.messagesReceived++;
        const parsed = binary
          ? { kind: 'rejected' as const, reason: 'BINARY_MESSAGE' }
          : normalizeMessage(
              raw,
              new Date().toISOString(),
              config.SCANNER_MAX_MESSAGE_BYTES,
            );
        if (parsed.kind === 'ack') client.acknowledge(parsed.subscription);
        else if (parsed.kind === 'providerError') {
          counters.rejectedMessages++;
          logger.error(
            { authentication: parsed.authentication },
            'PumpPortal rejected the subscription; provider details suppressed',
          );
          client.disconnect(
            parsed.authentication
              ? 'AUTHENTICATION_FAILED'
              : 'CONNECTION_ERROR',
            parsed.authentication,
          );
        } else if (parsed.kind === 'rejected') {
          counters.rejectedMessages++;
          logger.warn(
            { reason: parsed.reason },
            'Scanner message rejected; provider data may be incomplete',
          );
          if (parsed.reason !== 'UNKNOWN_MESSAGE')
            client.disconnect('INVALID_MESSAGE');
        } else {
          counters.validEvents++;
          if (!queue.offer({ kind: 'event', value: parsed.value })) {
            counters.droppedEvents++;
            logger.error(
              { eventId: parsed.value.event.id, queueDepth: queue.depth },
              'Scanner queue saturated; message not accepted, opening data gap',
            );
            client.disconnect('QUEUE_SATURATED');
          }
        }
      },
      gap(value) {
        if (!queue.offer({ kind: 'gap', value }, true)) {
          lostAcceptedEvents = true;
          logger.error(
            value,
            'Scanner gap journal saturated; interval recorded in logs only',
          );
        }
      },
      reconnect() {
        counters.reconnections++;
      },
      canReconnect: () => !stopping && queue.depth === 0,
    },
    factory,
  );
  const snapshot = () => ({
    ...counters,
    queueDepth: queue.depth,
    connectionStatus: client.status,
    subscriptionsReady: client.subscriptionsReady,
  });

  return {
    get status() {
      return client.status;
    },
    metrics: snapshot,
    async start(): Promise<void> {
      if (started || stopping) return;
      if (!config.SCANNER_ENABLED) {
        logger.info('Solemn scanner disabled');
        return;
      }
      started = true;
      client.start();
      metricsTimer = setInterval(
        () => logger.info(snapshot(), 'Solemn scanner metrics'),
        config.SCANNER_METRICS_INTERVAL_MS,
      );
    },
    async stop(): Promise<void> {
      shutdown ??= (async () => {
        stopping = true;
        clearInterval(metricsTimer);
        if (!started) return;
        await client.stop();
        try {
          await queue.stopAndDrain(config.SCANNER_DRAIN_TIMEOUT_MS);
        } finally {
          logger.info(snapshot(), 'Solemn scanner stopped');
        }
        if (lostAcceptedEvents)
          throw new Error(
            'Scanner reported possible accepted event or gap journal loss; inspect structured logs',
          );
      })();
      return shutdown;
    },
    waitForIdle: () => queue.waitForIdle(),
  };
}

export type ScannerService = ReturnType<typeof createScannerService>;
