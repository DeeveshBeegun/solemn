import type { Order, OrderRequest, Trade } from '@solemn/shared';

export interface OrderResult {
  order: Order;
  trades: Trade[];
  failureReason: string | null;
}

export interface CancelResult {
  order: Order;
  cancelled: boolean;
}

export interface ExecutionAdapter {
  placeOrder(request: OrderRequest): Promise<OrderResult>;
  getOrder(orderId: string): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<CancelResult>;
}
