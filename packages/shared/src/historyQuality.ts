import { createHash } from 'node:crypto';
import { canonicalJson, stableHash } from './identity.js';
import { historicalEventSchema, historicalSortKey } from './backtest.js';
import type {
  HistoricalEvent,
  HistoricalManifest,
  DatasetQuality,
} from './backtest.js';

/** Fixed-size per-minute bitmaps cap quality-analysis memory at < 40 MiB for the format's 90-day/100-market limit. */
export async function analyzeHistory(
  manifest: HistoricalManifest,
  events: AsyncIterable<HistoricalEvent>,
) {
  const start = Date.parse(manifest.startTime),
    minutes = Math.ceil((Date.parse(manifest.endTime) - start) / 60000);
  const markets = new Map(
    manifest.markets.map((market) => [
      `${market.mint}:${market.poolAddress}`,
      {
        coverage: new Uint8Array(minutes),
        gaps: new Uint8Array(minutes),
        prices: new Uint8Array(minutes),
        risk: false,
      },
    ]),
  );
  const quality: DatasetQuality = {
    totalTokens: manifest.markets.length,
    totalEvents: 0,
    totalTrades: 0,
    executionObservations: 0,
    earliestObservation: null,
    latestObservation: null,
    missingTimestamps: 0,
    duplicateEvents: 0,
    marketDataGaps: 0,
    missingPriceObservations: 0,
    missingLiquidityInformation: 0,
    missingHistoricalSecurityAssessments: 0,
    tokensWithInsufficientStrategyHistory: 0,
    unknownSourceEvents: 0,
    uncertainOrderingGroups: 0,
    missingHistoricalIntervals: 0,
    readiness: 'READY_WITH_LIMITATIONS',
    limitations: [],
  };
  const hash = createHash('sha256')
    .update(canonicalJson(manifest))
    .update('\n');
  let previousKey = '',
    previousHash = '',
    previousAvailable = '',
    groups = new Map<string, string>(),
    ambiguousGroups = new Set<string>();
  for await (const input of events) {
    const event = historicalEventSchema.parse(input),
      key = historicalSortKey(event),
      eventHash = stableHash(event);
    if (key < previousKey)
      throw new Error('Historical events are not canonically ordered');
    if (key === previousKey) {
      if (eventHash !== previousHash)
        throw new Error('Conflicting historical event identity');
      quality.duplicateEvents++;
      continue;
    }
    previousKey = key;
    previousHash = eventHash;
    const market = markets.get(`${event.mint}:${event.poolAddress}`);
    if (!market)
      throw new Error('Historical event references an unsupported pool');
    if (
      Date.parse(event.availableAt) < start ||
      Date.parse(event.availableAt) > Date.parse(manifest.endTime)
    )
      throw new Error('Historical availability falls outside dataset bounds');
    hash.update(canonicalJson(event)).update('\n');
    quality.totalEvents++;
    quality.earliestObservation ??= event.availableAt;
    quality.latestObservation = event.availableAt;
    if (event.eventAt === null) quality.missingTimestamps++;
    if (event.kind === 'UNKNOWN') quality.unknownSourceEvents++;
    if (event.kind === 'TRADE') {
      quality.totalTrades++;
      if (
        event.data.priceUsd === null ||
        !event.data.usdReliable ||
        event.data.volumeUsd === null
      )
        quality.missingPriceObservations++;
      else {
        const index = Math.floor(
          (Date.parse(event.data.timestamp) - start) / 60000,
        );
        if (index >= 0 && index < minutes) market.prices[index] = 1;
      }
    }
    if (event.kind === 'EXECUTION') {
      quality.executionObservations++;
      if (event.data.priceUsd === null || !event.data.usdReliable)
        quality.missingPriceObservations++;
      if (event.data.liquidityUsd === null)
        quality.missingLiquidityInformation++;
    }
    if (event.kind === 'COVERAGE') {
      const index = Math.floor((Date.parse(event.data.start) - start) / 60000);
      if (index >= 0 && index < minutes) {
        if (event.data.kind === 'GAP') {
          market.gaps[index] = 1;
          quality.marketDataGaps++;
        } else market.coverage[index] = 1;
      }
    }
    if (event.kind === 'RISK') {
      if (event.data.assessment === null)
        quality.missingHistoricalSecurityAssessments++;
      else {
        market.risk = true;
        if (event.data.assessment.checks.liquidityUsd === null)
          quality.missingLiquidityInformation++;
      }
    }
    if (event.availableAt !== previousAvailable) {
      previousAvailable = event.availableAt;
      groups = new Map();
      ambiguousGroups = new Set();
    }
    if (
      (event.kind === 'TRADE' || event.kind === 'EXECUTION') &&
      (event.slot === null || event.transactionIndex === null)
    ) {
      const group = `${event.kind}:${event.mint}:${event.poolAddress}:${event.eventAt}:${event.kind === 'EXECUTION' ? event.data.side : ''}`;
      const value = stableHash(
        event.kind === 'TRADE'
          ? [event.data.priceUsd]
          : [event.data.priceUsd, event.data.liquidityUsd],
      );
      const previous = groups.get(group);
      if (previous && previous !== value && !ambiguousGroups.has(group)) {
        quality.uncertainOrderingGroups++;
        ambiguousGroups.add(group);
      }
      groups.set(group, value);
      if (groups.size > 1000)
        throw new Error(
          'Historical timestamp cohort exceeds bounded ordering capacity',
        );
    }
  }
  for (const market of markets.values()) {
    let consecutive = 0,
      sufficient = false;
    for (let index = 0; index < minutes; index++) {
      const covered = market.coverage[index] === 1 && market.gaps[index] === 0;
      if (!covered) quality.missingHistoricalIntervals++;
      consecutive = covered && market.prices[index] === 1 ? consecutive + 1 : 0;
      if (consecutive >= 10) sufficient = true;
    }
    if (!market.risk) quality.missingHistoricalSecurityAssessments++;
    if (!sufficient) quality.tokensWithInsufficientStrategyHistory++;
  }
  if (!quality.totalEvents || !quality.totalTrades)
    quality.readiness = 'INSUFFICIENT';
  if (manifest.sourceKind === 'SYNTHETIC')
    quality.limitations.push(
      'Synthetic fixture data: results are not actual historical trading performance.',
    );
  if (quality.missingHistoricalIntervals)
    quality.limitations.push(
      'Missing or disconnected observation intervals exist; affected strategy windows are unavailable.',
    );
  if (quality.missingTimestamps)
    quality.limitations.push(
      'Some events lack event time; availability time is retained without inventing blockchain timing.',
    );
  if (quality.uncertainOrderingGroups)
    quality.limitations.push(
      'Ambiguous same-time prices require conservative rejection, not signature-based inferred order.',
    );
  quality.limitations.push(
    'The declared token universe may have survivorship/selection bias; historical imports are not independently verified.',
  );
  return { fingerprint: hash.digest('hex'), quality };
}
