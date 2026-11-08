import { getAddressDecoder } from '@solana/kit';
import { marketDatasetSchema, multiplyDecimal, stableId } from '@solemn/shared';
import type { FixtureMarket, NormalizedMarketTrade } from '@solemn/shared';
import type { Config } from '../config/index.js';
import { emptyJupiter, emptySecurity } from '../analysis/observations.js';
import { SPL_TOKEN_PROGRAM } from '../analysis/tokenSecurity.js';
import { evaluateTokenRisk, riskPolicy } from '../risk/tokenRiskEngine.js';

const address = (seed: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(seed));
export const replayTime = (minute: number, milliseconds = 0) =>
  new Date(
    Date.parse('2026-01-01T00:00:00.000Z') + minute * 60000 + milliseconds,
  ).toISOString();
export const replayCases = [
  'breakout',
  'weak',
  'rejected',
  'failed',
  'incomplete',
] as const;
/** Synthetic research observations, never represented as real token/risk history. */
export function createReplayFixture(config: Config) {
  const markets: FixtureMarket[] = replayCases.map((name, marketIndex) => {
    const mint = address(10 + marketIndex),
      poolAddress = address(20 + marketIndex),
      quoteMint = address(30);
    const market: FixtureMarket = {
      mint,
      poolAddress,
      quoteMint,
      poolCreatedAt: replayTime(0),
      trades: [],
      coverage: [],
      risks: [],
    };
    for (let minute = 0; minute < 18; minute++) {
      const active = name !== 'weak' && minute >= 11;
      const prices = !active
        ? ['100', '100', '100', '100']
        : minute === 11
          ? ['100', '120', '100', '120']
          : minute === 12
            ? ['118', '119', '105', '108']
            : minute === 13
              ? name === 'failed'
                ? ['108', '119', '99', '100']
                : ['110', '125', '110', '124']
              : name === 'failed'
                ? ['100', '100', '100', '100']
                : ['124', '124', '124', '124'];
      for (let tick = 0; tick < 12; tick++) {
        const timestamp = replayTime(minute, (tick + 1) * 4000),
          sourceEventId = `${name}:${minute}:${tick}`;
        const priceUsd = prices[
          tick === 0 ? 0 : tick === 1 ? 1 : tick === 2 ? 2 : 3
        ] as string;
        const tokenAmount = active ? '1' : '0.1',
          volumeUsd = multiplyDecimal(tokenAmount, priceUsd);
        const trade: NormalizedMarketTrade = {
          id: stableId(['market-trade', 'SOLEMN_FIXTURE', sourceEventId]),
          mint,
          poolAddress,
          timestamp,
          receivedAt: new Date(Date.parse(timestamp) + 100).toISOString(),
          side: tick < 10 ? 'BUY' : 'SELL',
          tokenAmount,
          quoteAmount: volumeUsd,
          quoteMint,
          priceUsd,
          volumeUsd,
          usdReliable: true,
          usdSource: 'FIXTURE_USD_QUOTE',
          usdObservedAt: timestamp,
          traderAddress: address(50 + minute * 10 + (tick % 10)),
          transactionSignature: null,
          source: 'SOLEMN_FIXTURE',
          sourceEventId,
          rawPayload: { fixture: true, scenario: name },
        };
        if (name === 'incomplete' && minute === 9) {
          trade.usdReliable = false;
          trade.volumeUsd = null;
          trade.usdSource = null;
        }
        market.trades.push(trade);
      }
      market.coverage.push({
        id: stableId(['coverage', name, minute]),
        start: replayTime(minute),
        end: replayTime(minute + 1),
        availableAt: replayTime(minute + 1, 1000),
        kind: name === 'incomplete' && minute === 8 ? 'GAP' : 'OBSERVED',
        reason:
          name === 'incomplete' && minute === 8
            ? 'FIXTURE_DISCONNECTION'
            : null,
      });
      const assessedAt = replayTime(minute + 1, -1000),
        requestId = stableId(['fixture-risk', name, minute]);
      const jupiter = {
        ...emptyJupiter(mint, assessedAt),
        state: 'OK' as const,
        updatedAt: assessedAt,
        tokenProgram: SPL_TOKEN_PROGRAM,
        liquidityUsd: '50000',
        usdPrice: priceUsdAtEnd(prices),
        holderCount: '1000',
        mintAuthorityDisabled: true,
        freezeAuthorityDisabled: true,
        topHoldersPercentage: '25',
        isSus: false,
        rawResponse: '{"fixture":true}',
      };
      const solana = {
        ...emptySecurity(mint, assessedAt),
        state: 'OK' as const,
        tokenProgram: SPL_TOKEN_PROGRAM,
        validMint: true,
        mintAuthorityDisabled: name !== 'rejected',
        freezeAuthorityDisabled: true,
        decimals: 9,
        supplyBaseUnits: '1000000000000',
        supportedExtensions: true,
        contextSlot: '100',
      };
      const assessment = evaluateTokenRisk(
        {
          tokenMint: mint,
          requestId,
          requestedAt: assessedAt,
          attempt: 1,
          trigger: 'FIXTURE',
          previous: null,
        },
        jupiter,
        solana,
        riskPolicy(config),
        assessedAt,
      );
      market.risks.push({
        currentStatus: assessment.status,
        currentRequestId: requestId,
        assessment,
        availableAt: assessedAt,
      });
    }
    return market;
  });
  return marketDatasetSchema.parse({
    format: 'SOLEMN_MARKET_REPLAY_V1',
    name: 'Week 4 synthetic five-case replay',
    start: replayTime(0),
    end: replayTime(18),
    markets,
  });
}
function priceUsdAtEnd(prices: string[]) {
  return prices.at(-1) as string;
}
