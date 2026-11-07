import type { OrderStatus } from './types/index.js';

const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ['SUBMITTED', 'FAILED', 'CANCELLED'],
  SUBMITTED: ['PARTIALLY_FILLED', 'FILLED', 'FAILED', 'CANCELLED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'FAILED', 'CANCELLED'],
  FILLED: [],
  FAILED: [],
  CANCELLED: [],
};

export function assertOrderTransition(
  from: OrderStatus,
  to: OrderStatus,
): void {
  if (!transitions[from].includes(to)) {
    throw new Error(`Invalid order transition: ${from} -> ${to}`);
  }
}
