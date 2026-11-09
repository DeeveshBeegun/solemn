import type {
  PaperRepository,
  strategyEvaluationPeriods,
} from '@solemn/database';
import type {
  BacktestPlan,
  DatasetQuality,
  ExecutionConfig,
  HistoricalMarket,
  PaperAccountDefinition,
  PaperPortfolioState,
  PaperOrderRecord,
  StrategyDecision,
} from '@solemn/shared';

export const sources = [
  'historical',
  'synthetic',
  'forward-replay',
  'forward',
  'paper-replay',
] as const;
export type Source = (typeof sources)[number];
export const periodKinds = [
  'DEVELOPMENT',
  'VALIDATION',
  'HOLDOUT',
  'FORWARD',
] as const;
export type PeriodKind = (typeof periodKinds)[number];
export const reportVersion = 'SOLEMN_ANALYTICS_V1';
export type JournalRow = Awaited<
  ReturnType<PaperRepository['history']>
>[number];
export type Registration = typeof strategyEvaluationPeriods.$inferSelect;
export interface Selection {
  strategyId: string;
  source?: Source;
  portfolioId?: string;
  start?: string;
  end?: string;
  type?: PeriodKind;
  periodId?: string;
}
export interface EquityPoint {
  at: string;
  equityUsd: string | null;
  reason: string | null;
}
export interface AttributionEvent {
  signalId: string;
  at: string | null;
  status: string;
  reasons: string[];
  orderId: string | null;
}
export interface SourceObservations {
  discovered: string[] | null;
  analyzed: string[] | null;
  eligible: string[] | null;
  watched: string[] | null;
  marketGaps: number | null;
  downtimeMs: number | null;
  observationCount: number | null;
  rawTradeCount: number | null;
  missingPrice: number | null;
  missingLiquidity: number | null;
  missingRisk: number | null;
  duplicates: number | null;
  rejected: number | null;
  observedRuntimeMs: number | null;
}
export interface CapturedPortfolio {
  source: Source;
  portfolioId: string;
  strategyId: string;
  sourceId: string;
  runId: string | null;
  definition: PaperAccountDefinition;
  execution: ExecutionConfig | null;
  configurationHash: string;
  start: string;
  end: string;
  availableStart: string;
  availableEnd: string;
  periodType: PeriodKind;
  registration: Registration | null;
  startState: PaperPortfolioState;
  endState: PaperPortfolioState;
  journal: JournalRow[];
  priorOrders: PaperOrderRecord[];
  decisions: StrategyDecision[];
  intents: AttributionEvent[];
  equity: EquityPoint[];
  markets: HistoricalMarket[];
  quality: DatasetQuality | null;
  observations: SourceObservations;
  cadence: Pick<BacktestPlan, 'startTime' | 'equityCadenceMs'> | null;
  sourceFingerprint: string;
  inputFingerprint: string;
}
export const iso = (value: string) => new Date(value).toISOString();
export const inPeriod = (value: string, start: string, end: string) => {
  const time = Date.parse(value);
  return time >= Date.parse(start) && time <= Date.parse(end);
};
