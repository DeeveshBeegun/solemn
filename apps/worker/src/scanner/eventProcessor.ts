import { setTimeout as delay } from 'node:timers/promises';
import type { ScannerRepository } from '@solemn/database';
import type { ScannerEvent, ScannerGap } from '@solemn/shared';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { safeError } from '../services/logger.js';

export type IngestionItem =
  { kind: 'event'; value: ScannerEvent } | { kind: 'gap'; value: ScannerGap };
export const createCounters = () => ({
  messagesReceived: 0,
  validEvents: 0,
  rejectedMessages: 0,
  duplicateEvents: 0,
  successfulWrites: 0,
  failedWrites: 0,
  reconnections: 0,
  droppedEvents: 0,
});
export type ScannerCounters = ReturnType<typeof createCounters>;

export function isTransientDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (
    'cause' in error &&
    error.cause !== error &&
    isTransientDatabaseError(error.cause)
  )
    return true;
  const code = 'code' in error ? error.code : null;
  return (
    typeof code === 'string' &&
    (code.startsWith('08') ||
      [
        '40001',
        '40P01',
        '55P03',
        '57014',
        '53300',
        '57P01',
        '57P02',
        '57P03',
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EPIPE',
        'ENETUNREACH',
        'EHOSTUNREACH',
      ].includes(code))
  );
}

export function createEventProcessor(
  repository: ScannerRepository,
  config: Config,
  logger: Logger,
  counters: ScannerCounters,
  onPersisted?: (event: ScannerEvent) => void,
) {
  return async (item: IngestionItem, signal: AbortSignal): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        if (item.kind === 'gap') await repository.recordGap(item.value);
        else {
          const result = await repository.persistEvent(item.value);
          if (result === 'DUPLICATE') counters.duplicateEvents++;
          else {
            counters.successfulWrites++;
            onPersisted?.(item.value);
            logger.info(
              {
                mint: item.value.event.tokenMint,
                eventType: item.value.event.eventType,
                eventId: item.value.event.id,
              },
              item.value.event.eventType === 'TOKEN_CREATED'
                ? 'New token discovered and persisted'
                : 'Token migration observed and persisted',
            );
          }
        }
        return;
      } catch (error) {
        counters.failedWrites++;
        logger.warn(
          { ...safeError(error), attempt, itemKind: item.kind },
          'Scanner persistence attempt failed',
        );
        if (
          attempt >= config.SCANNER_DB_MAX_ATTEMPTS ||
          !isTransientDatabaseError(error)
        )
          throw error;
        await delay(
          Math.min(config.SCANNER_DB_RETRY_MS * 2 ** (attempt - 1), 30000),
          undefined,
          { signal },
        );
      }
    }
  };
}
