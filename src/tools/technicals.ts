/**
 * Technical analysis tools -- get_price_history, calculate_moving_averages,
 * calculate_rsi, calculate_macd, get_technical_summary.
 *
 * Phase 3 implementation -- follows the exact pattern from src/tools/company.ts.
 * Uses utility functions from src/utils/financial-math.ts (sma, ema, rsi, macd).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from '../db/connection.js';
import type { RedisClient } from '../cache/redis.js';
import * as queries from '../db/queries.js';
import { cacheGet, cacheSet, cacheKey, TTL } from '../cache/redis.js';
import {
  buildResponse,
  buildErrorResponse,
  normalizeTicker,
} from '../utils/response-builder.js';
import { sma, ema, rsi, macd } from '../utils/financial-math.js';

// ============================================================
// HELPERS
// ============================================================

/** Map human-readable period strings to calendar days. */
const PERIOD_DAYS: Record<string, number> = {
  '1m': 30,
  '3m': 90,
  '6m': 180,
  '1y': 365,
  '2y': 730,
  '3y': 1095,
  '5y': 1825,
  '10y': 3650,
  'max': 99999,
};

function periodToDays(period: string): number {
  return PERIOD_DAYS[period.toLowerCase()] ?? 365;
}

/** Safely convert a DB numeric column to a JS number. */
function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isFinite(n) ? n : 0;
}

function roundTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

interface PriceRow {
  trade_date: string;
  open_price: unknown;
  high_price: unknown;
  low_price: unknown;
  close_price: unknown;
  adj_close: unknown;
  volume: unknown;
  delivery_percentage: unknown;
}

/** Aggregate daily rows into weekly or monthly candles. */
function aggregateCandles(
  rows: PriceRow[],
  interval: 'weekly' | 'monthly'
): Array<{
  period_start: string;
  period_end: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> {
  if (rows.length === 0) return [];

  const buckets = new Map<string, PriceRow[]>();

  for (const row of rows) {
    const d = new Date(row.trade_date);
    let key: string;
    if (interval === 'weekly') {
      // ISO week: use Monday as start
      const day = d.getDay();
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((day + 6) % 7));
      key = monday.toISOString().slice(0, 10);
    } else {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(row);
  }

  const candles: Array<{
    period_start: string;
    period_end: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];

  for (const [, group] of buckets) {
    const opens = group.map((r) => toNum(r.open_price));
    const highs = group.map((r) => toNum(r.high_price));
    const lows = group.map((r) => toNum(r.low_price));
    const closes = group.map((r) => toNum(r.close_price));
    const volumes = group.map((r) => toNum(r.volume));

    candles.push({
      period_start: String(group[0].trade_date).slice(0, 10),
      period_end: String(group[group.length - 1].trade_date).slice(0, 10),
      open: opens[0],
      high: Math.max(...highs),
      low: Math.min(...lows.filter((l) => l > 0)),
      close: closes[closes.length - 1],
      volume: volumes.reduce((a, b) => a + b, 0),
    });
  }

  return candles.sort((a, b) => a.period_start.localeCompare(b.period_start));
}

/**
 * Find recent swing highs/lows from price data as support/resistance levels.
 * Uses a simple local-min/max approach over a lookback window.
 */
function findSupportResistance(
  closes: number[],
  highs: number[],
  lows: number[],
  windowSize = 5
): { support: number[]; resistance: number[] } {
  const support: number[] = [];
  const resistance: number[] = [];

  for (let i = windowSize; i < closes.length - windowSize; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= windowSize; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) {
        isSwingHigh = false;
      }
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) {
        isSwingLow = false;
      }
    }

    if (isSwingHigh) resistance.push(roundTo(highs[i], 2));
    if (isSwingLow) support.push(roundTo(lows[i], 2));
  }

  // Deduplicate nearby levels (within 1% of each other)
  const dedup = (arr: number[]): number[] => {
    const sorted = [...arr].sort((a, b) => a - b);
    const result: number[] = [];
    for (const val of sorted) {
      if (result.length === 0 || Math.abs(val - result[result.length - 1]) / result[result.length - 1] > 0.01) {
        result.push(val);
      }
    }
    return result;
  };

  return {
    support: dedup(support).slice(-5),
    resistance: dedup(resistance).slice(-5),
  };
}

/**
 * Determine signal strength from individual indicator signals.
 * Returns a rating from "strong sell" to "strong buy".
 */
function computeOverallSignal(
  signals: Array<{ indicator: string; signal: 'buy' | 'sell' | 'neutral' }>
): { rating: string; score: number; buyCount: number; sellCount: number; neutralCount: number } {
  let buyCount = 0;
  let sellCount = 0;
  let neutralCount = 0;

  for (const s of signals) {
    if (s.signal === 'buy') buyCount++;
    else if (s.signal === 'sell') sellCount++;
    else neutralCount++;
  }

  const total = signals.length;
  const score = total > 0 ? roundTo((buyCount - sellCount) / total, 2) : 0;

  let rating: string;
  if (score >= 0.6) rating = 'Strong Buy';
  else if (score >= 0.2) rating = 'Buy';
  else if (score > -0.2) rating = 'Neutral';
  else if (score > -0.6) rating = 'Sell';
  else rating = 'Strong Sell';

  return { rating, score, buyCount, sellCount, neutralCount };
}

// ============================================================
// CACHE TTL for technicals (reuse LATEST_PRICE = 5min for intraday-relevant data)
// ============================================================
const TECH_TTL = TTL.LATEST_PRICE;

// ============================================================
// REGISTER TOOLS
// ============================================================

export function registerTools(
  server: McpServer,
  db: Pool,
  _cache: RedisClient
): void {

  // ------------------------------------------------------------------
  // get_price_history
  // ------------------------------------------------------------------
  server.tool(
    'get_price_history',
    'Retrieve OHLCV price history for a company over a given period. Returns daily, ' +
    'weekly, or monthly candles with open, high, low, close, and volume. Supported ' +
    'periods: 1m, 3m, 6m, 1y, 2y, 3y, 5y, 10y, max. Weekly and monthly intervals ' +
    'aggregate daily data using the last trading day per period. ' +
    'Example: get_price_history({ ticker: "RELIANCE", period: "1y", interval: "daily" })',
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol, e.g. "RELIANCE", "TCS". .NS/.BO suffixes stripped automatically.'
      ),
      period: z.enum(['1m', '3m', '6m', '1y', '2y', '3y', '5y', '10y', 'max']).optional().describe(
        'Time period (default "1y")'
      ),
      interval: z.enum(['daily', 'weekly', 'monthly']).optional().describe(
        'Candle interval (default "daily")'
      ),
    },
    async ({ ticker, period, interval }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const effectivePeriod = period ?? '1y';
        const effectiveInterval = interval ?? 'daily';
        const days = periodToDays(effectivePeriod);

        const key = cacheKey('price_history', normalized, { period: effectivePeriod, interval: effectiveInterval });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Price history for ${normalized} (${effectivePeriod}, ${effectiveInterval}) (cached)`,
                data: cached,
                context: { ticker: normalized, period: effectivePeriod },
                relatedTools: ['calculate_moving_averages', 'calculate_rsi', 'get_technical_summary'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          const suggestions = await queries.searchCompanies(db, normalized, { limit: 3 });
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_price_history',
                `Company "${normalized}" not found.`,
                suggestions.length > 0
                  ? `Did you mean: ${suggestions.map((s: { ticker: string }) => s.ticker).join(', ')}?`
                  : 'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        const rows: PriceRow[] = await queries.getPriceHistory(db, company.id, days);

        if (rows.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_price_history',
                `No price data available for ${normalized} in the requested period.`,
                'Price data may not have been ingested yet. Try a shorter period or run the ingestion pipeline.'
              ),
            }],
          };
        }

        let resultData: unknown;
        if (effectiveInterval === 'daily') {
          resultData = rows.map((r) => ({
            date: String(r.trade_date).slice(0, 10),
            open: toNum(r.open_price),
            high: toNum(r.high_price),
            low: toNum(r.low_price),
            close: toNum(r.close_price),
            adjClose: toNum(r.adj_close),
            volume: toNum(r.volume),
          }));
        } else {
          resultData = aggregateCandles(rows, effectiveInterval);
        }

        const firstClose = toNum(rows[0].close_price);
        const lastClose = toNum(rows[rows.length - 1].close_price);
        const changePercent = firstClose > 0 ? roundTo(((lastClose - firstClose) / firstClose) * 100, 2) : 0;

        const result = {
          ticker: normalized,
          period: effectivePeriod,
          interval: effectiveInterval,
          dataPoints: Array.isArray(resultData) ? resultData.length : 0,
          priceChange: `${changePercent}%`,
          latestClose: lastClose,
          candles: resultData,
        };

        await cacheSet(key, result, TECH_TTL);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${normalized} price history (${effectivePeriod}, ${effectiveInterval}): ${Array.isArray(resultData) ? resultData.length : 0} data points, ${changePercent >= 0 ? '+' : ''}${changePercent}% change`,
              data: result,
              context: {
                ticker: normalized,
                period: effectivePeriod,
                units: { price: 'INR', volume: 'Shares' },
              },
              relatedTools: ['calculate_moving_averages', 'calculate_rsi', 'calculate_macd', 'get_technical_summary'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_price_history',
              err instanceof Error ? err.message : 'Price history lookup failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // calculate_moving_averages
  // ------------------------------------------------------------------
  server.tool(
    'calculate_moving_averages',
    'Calculate Simple and Exponential Moving Averages for a company. Returns SMA and ' +
    'EMA for each requested period along with current price position relative to each MA ' +
    '(above/below) and crossover signals. Default periods: 20, 50, 200. ' +
    'Example: calculate_moving_averages({ ticker: "INFY", periods: [20, 50, 200] })',
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol'
      ),
      periods: z.array(z.number().min(2).max(500)).optional().describe(
        'MA periods to calculate (default [20, 50, 200])'
      ),
    },
    async ({ ticker, periods }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const maPeriods = periods ?? [20, 50, 200];

        const key = cacheKey('moving_averages', normalized, { periods: maPeriods });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Moving averages for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['calculate_rsi', 'calculate_macd', 'get_technical_summary'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('calculate_moving_averages', `Company "${normalized}" not found.`),
            }],
          };
        }

        // Fetch enough data for the longest MA period + buffer
        const maxPeriod = Math.max(...maPeriods);
        const daysNeeded = Math.ceil(maxPeriod * 1.8); // trading days to calendar days
        const rows = await queries.getPriceHistory(db, company.id, daysNeeded);

        if (rows.length < maxPeriod) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'calculate_moving_averages',
                `Not enough price data for ${normalized}. Need ${maxPeriod} trading days, found ${rows.length}.`,
                'Try shorter MA periods or ensure price data is ingested.'
              ),
            }],
          };
        }

        const closes = rows.map((r: PriceRow) => toNum(r.close_price));
        const currentPrice = closes[closes.length - 1];

        const maResults: Array<{
          period: number;
          sma: number;
          ema: number;
          priceVsSma: string;
          priceVsEma: string;
          smaSignal: 'buy' | 'sell' | 'neutral';
          emaSignal: 'buy' | 'sell' | 'neutral';
        }> = [];

        for (const p of maPeriods) {
          const smaValues = sma(closes, p);
          const emaValues = ema(closes, p);

          const latestSma = smaValues.length > 0 ? roundTo(smaValues[smaValues.length - 1], 2) : 0;
          const latestEma = emaValues.length > 0 ? roundTo(emaValues[emaValues.length - 1], 2) : 0;

          const smaSignal: 'buy' | 'sell' | 'neutral' = currentPrice > latestSma ? 'buy' : currentPrice < latestSma ? 'sell' : 'neutral';
          const emaSignal: 'buy' | 'sell' | 'neutral' = currentPrice > latestEma ? 'buy' : currentPrice < latestEma ? 'sell' : 'neutral';

          maResults.push({
            period: p,
            sma: latestSma,
            ema: latestEma,
            priceVsSma: currentPrice > latestSma ? 'above' : currentPrice < latestSma ? 'below' : 'at',
            priceVsEma: currentPrice > latestEma ? 'above' : currentPrice < latestEma ? 'below' : 'at',
            smaSignal,
            emaSignal,
          });
        }

        // Detect golden cross / death cross (50 vs 200 SMA)
        let crossoverSignal: string | null = null;
        if (maPeriods.includes(50) && maPeriods.includes(200)) {
          const sma50 = sma(closes, 50);
          const sma200 = sma(closes, 200);
          if (sma50.length >= 2 && sma200.length >= 2) {
            const offset50 = sma50.length - sma200.length;
            if (offset50 >= 1) {
              const prev50 = sma50[sma50.length - 2 - (sma50.length - sma200.length - offset50)];
              const curr50 = sma50[sma50.length - 1];
              const prev200 = sma200[sma200.length - 2];
              const curr200 = sma200[sma200.length - 1];

              if (prev50 !== undefined && curr50 !== undefined && prev200 !== undefined && curr200 !== undefined) {
                if (prev50 < prev200 && curr50 > curr200) {
                  crossoverSignal = 'Golden Cross (50 SMA crossed above 200 SMA) -- bullish';
                } else if (prev50 > prev200 && curr50 < curr200) {
                  crossoverSignal = 'Death Cross (50 SMA crossed below 200 SMA) -- bearish';
                }
              }
            }
          }
        }

        const result = {
          ticker: normalized,
          currentPrice: roundTo(currentPrice, 2),
          dataPointsUsed: closes.length,
          movingAverages: maResults,
          crossoverSignal,
        };

        await cacheSet(key, result, TECH_TTL);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${normalized} at ${roundTo(currentPrice, 2)}: ${maResults.map((m) => `${m.period}-MA ${m.priceVsSma}`).join(', ')}${crossoverSignal ? ` | ${crossoverSignal}` : ''}`,
              data: result,
              context: {
                ticker: normalized,
                units: { price: 'INR', sma: 'INR', ema: 'INR' },
              },
              relatedTools: ['calculate_rsi', 'calculate_macd', 'get_technical_summary', 'get_price_history'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'calculate_moving_averages',
              err instanceof Error ? err.message : 'Moving average calculation failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // calculate_rsi
  // ------------------------------------------------------------------
  server.tool(
    'calculate_rsi',
    'Calculate the Relative Strength Index for a company. Returns the current RSI value, ' +
    'historical RSI series, overbought/oversold status, and divergence signals. Default ' +
    'period is 14. RSI above 70 is overbought, below 30 is oversold. ' +
    'Example: calculate_rsi({ ticker: "TCS", period: 14 })',
    {
      ticker: z.string().min(1).describe('Company ticker symbol'),
      period: z.number().min(2).max(100).optional().describe('RSI period (default 14)'),
    },
    async ({ ticker, period }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const rsiPeriod = period ?? 14;

        const key = cacheKey('rsi', normalized, { period: rsiPeriod });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `RSI for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['calculate_moving_averages', 'calculate_macd', 'get_technical_summary'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('calculate_rsi', `Company "${normalized}" not found.`),
            }],
          };
        }

        // Need enough data for RSI: period + buffer for smoothing
        const rows = await queries.getPriceHistory(db, company.id, Math.ceil(rsiPeriod * 5));
        const closes = rows.map((r: PriceRow) => toNum(r.close_price));

        if (closes.length < rsiPeriod + 1) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'calculate_rsi',
                `Not enough price data for RSI calculation. Need at least ${rsiPeriod + 1} data points, found ${closes.length}.`
              ),
            }],
          };
        }

        const rsiValues = rsi(closes, rsiPeriod);

        if (rsiValues.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('calculate_rsi', 'RSI calculation returned no values. Insufficient data.'),
            }],
          };
        }

        const currentRsi = roundTo(rsiValues[rsiValues.length - 1], 2);
        const currentPrice = roundTo(closes[closes.length - 1], 2);

        let status: string;
        let signal: 'buy' | 'sell' | 'neutral';
        if (currentRsi >= 70) {
          status = 'Overbought';
          signal = 'sell';
        } else if (currentRsi <= 30) {
          status = 'Oversold';
          signal = 'buy';
        } else if (currentRsi >= 60) {
          status = 'Approaching overbought';
          signal = 'neutral';
        } else if (currentRsi <= 40) {
          status = 'Approaching oversold';
          signal = 'neutral';
        } else {
          status = 'Neutral';
          signal = 'neutral';
        }

        // Recent RSI history (last 20 values)
        const recentRsi = rsiValues.slice(-20).map((v) => roundTo(v, 2));

        const result = {
          ticker: normalized,
          currentPrice,
          period: rsiPeriod,
          currentRsi,
          status,
          signal,
          recentHistory: recentRsi,
          dataPointsUsed: closes.length,
        };

        await cacheSet(key, result, TECH_TTL);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${normalized} RSI(${rsiPeriod}): ${currentRsi} -- ${status}`,
              data: result,
              context: {
                ticker: normalized,
                units: { rsi: 'Scale 0-100', price: 'INR' },
              },
              relatedTools: ['calculate_moving_averages', 'calculate_macd', 'get_technical_summary'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse('calculate_rsi', err instanceof Error ? err.message : 'RSI calculation failed'),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // calculate_macd
  // ------------------------------------------------------------------
  server.tool(
    'calculate_macd',
    'Calculate MACD (Moving Average Convergence Divergence) for a company. Returns ' +
    'the MACD line, signal line, histogram, and crossover signals. Default parameters: ' +
    'fast=12, slow=26, signal=9. A bullish crossover occurs when MACD crosses above ' +
    'the signal line. Example: calculate_macd({ ticker: "HDFCBANK" })',
    {
      ticker: z.string().min(1).describe('Company ticker symbol'),
      fastPeriod: z.number().min(2).max(100).optional().describe('Fast EMA period (default 12)'),
      slowPeriod: z.number().min(2).max(200).optional().describe('Slow EMA period (default 26)'),
      signalPeriod: z.number().min(2).max(50).optional().describe('Signal EMA period (default 9)'),
    },
    async ({ ticker, fastPeriod, slowPeriod, signalPeriod }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const fast = fastPeriod ?? 12;
        const slow = slowPeriod ?? 26;
        const sig = signalPeriod ?? 9;

        const key = cacheKey('macd', normalized, { fast, slow, signal: sig });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `MACD for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['calculate_rsi', 'calculate_moving_averages', 'get_technical_summary'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('calculate_macd', `Company "${normalized}" not found.`),
            }],
          };
        }

        // Need enough data for the slow EMA + signal period + buffer
        const minData = slow + sig + 20;
        const rows = await queries.getPriceHistory(db, company.id, Math.ceil(minData * 2));
        const closes = rows.map((r: PriceRow) => toNum(r.close_price));

        if (closes.length < minData) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'calculate_macd',
                `Not enough price data. Need at least ${minData} data points, found ${closes.length}.`
              ),
            }],
          };
        }

        const macdResult = macd(closes, fast, slow, sig);

        if (macdResult.macdLine.length === 0 || macdResult.signalLine.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('calculate_macd', 'MACD calculation returned no values.'),
            }],
          };
        }

        const currentMacd = roundTo(macdResult.macdLine[macdResult.macdLine.length - 1], 4);
        const currentSignal = roundTo(macdResult.signalLine[macdResult.signalLine.length - 1], 4);
        const currentHistogram = roundTo(
          macdResult.histogram.length > 0 ? macdResult.histogram[macdResult.histogram.length - 1] : 0,
          4
        );

        // Detect crossover
        let crossover: string | null = null;
        let signal: 'buy' | 'sell' | 'neutral' = 'neutral';
        if (macdResult.histogram.length >= 2) {
          const prevHist = macdResult.histogram[macdResult.histogram.length - 2];
          if (prevHist <= 0 && currentHistogram > 0) {
            crossover = 'Bullish crossover (MACD crossed above signal line)';
            signal = 'buy';
          } else if (prevHist >= 0 && currentHistogram < 0) {
            crossover = 'Bearish crossover (MACD crossed below signal line)';
            signal = 'sell';
          }
        }

        // Trend strength from histogram direction
        let trend = 'neutral';
        if (macdResult.histogram.length >= 3) {
          const recent = macdResult.histogram.slice(-3);
          const increasing = recent[2] > recent[1] && recent[1] > recent[0];
          const decreasing = recent[2] < recent[1] && recent[1] < recent[0];
          if (currentHistogram > 0 && increasing) trend = 'strengthening bullish';
          else if (currentHistogram > 0 && decreasing) trend = 'weakening bullish';
          else if (currentHistogram < 0 && decreasing) trend = 'strengthening bearish';
          else if (currentHistogram < 0 && increasing) trend = 'weakening bearish';
        }

        // Recent MACD history (last 20)
        const histLen = Math.min(20, macdResult.histogram.length);
        const recentHistory = [];
        for (let i = macdResult.histogram.length - histLen; i < macdResult.histogram.length; i++) {
          const macdIdx = i + (macdResult.macdLine.length - macdResult.histogram.length);
          const sigIdx = i;
          recentHistory.push({
            macd: roundTo(macdResult.macdLine[macdIdx], 4),
            signal: roundTo(macdResult.signalLine[sigIdx], 4),
            histogram: roundTo(macdResult.histogram[i], 4),
          });
        }

        const result = {
          ticker: normalized,
          currentPrice: roundTo(closes[closes.length - 1], 2),
          parameters: { fast, slow, signal: sig },
          currentMacd,
          currentSignal,
          currentHistogram,
          crossover,
          signal,
          trend,
          recentHistory,
          dataPointsUsed: closes.length,
        };

        await cacheSet(key, result, TECH_TTL);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${normalized} MACD(${fast},${slow},${sig}): ${currentMacd}, Signal: ${currentSignal}, Histogram: ${currentHistogram}${crossover ? ` | ${crossover}` : ''} -- ${trend}`,
              data: result,
              context: {
                ticker: normalized,
                units: { macd: 'Price difference', histogram: 'Price difference' },
              },
              relatedTools: ['calculate_rsi', 'calculate_moving_averages', 'get_technical_summary'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse('calculate_macd', err instanceof Error ? err.message : 'MACD calculation failed'),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_technical_summary
  // ------------------------------------------------------------------
  server.tool(
    'get_technical_summary',
    'Get a comprehensive technical analysis summary combining all indicators for a ' +
    'company: moving averages (20/50/200 SMA and EMA), RSI with overbought/oversold ' +
    'signal, MACD with crossover detection, Bollinger Bands position, volume trend ' +
    'vs 20-day average, support/resistance levels from recent swing highs/lows, and ' +
    'an overall signal rating from "Strong Sell" to "Strong Buy" based on indicator ' +
    'alignment. This is the recommended starting point for any technical analysis. ' +
    'Example: get_technical_summary({ ticker: "RELIANCE" })',
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol, e.g. "RELIANCE", "TCS". .NS/.BO suffixes stripped automatically.'
      ),
    },
    async ({ ticker }) => {
      try {
        const normalized = normalizeTicker(ticker);

        const key = cacheKey('tech_summary', normalized);
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Technical summary for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['get_price_history', 'get_company_profile', 'get_valuation_metrics'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          const suggestions = await queries.searchCompanies(db, normalized, { limit: 3 });
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_technical_summary',
                `Company "${normalized}" not found.`,
                suggestions.length > 0
                  ? `Did you mean: ${suggestions.map((s: { ticker: string }) => s.ticker).join(', ')}?`
                  : 'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        // Fetch ~400 days of data (enough for 200-SMA + buffer)
        const rows = await queries.getPriceHistory(db, company.id, 600);

        if (rows.length < 50) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_technical_summary',
                `Not enough price data for ${normalized}. Need at least 50 trading days, found ${rows.length}.`,
                'Ensure price data has been ingested. Try get_price_history to check available data.'
              ),
            }],
          };
        }

        const closes = rows.map((r: PriceRow) => toNum(r.close_price));
        const highs = rows.map((r: PriceRow) => toNum(r.high_price));
        const lows = rows.map((r: PriceRow) => toNum(r.low_price));
        const volumes = rows.map((r: PriceRow) => toNum(r.volume));
        const currentPrice = roundTo(closes[closes.length - 1], 2);

        const signals: Array<{ indicator: string; signal: 'buy' | 'sell' | 'neutral'; detail: string }> = [];

        // ----- MOVING AVERAGES (20, 50, 200 SMA & EMA) -----
        const maPeriods = [20, 50, 200];
        const maData: Record<string, { sma: number | null; ema: number | null; smaSignal: string; emaSignal: string }> = {};

        for (const p of maPeriods) {
          if (closes.length >= p) {
            const smaVals = sma(closes, p);
            const emaVals = ema(closes, p);
            const latestSma = smaVals.length > 0 ? roundTo(smaVals[smaVals.length - 1], 2) : null;
            const latestEma = emaVals.length > 0 ? roundTo(emaVals[emaVals.length - 1], 2) : null;

            const smaSignal: 'buy' | 'sell' | 'neutral' =
              latestSma !== null ? (currentPrice > latestSma ? 'buy' : 'sell') : 'neutral';
            const emaSignal: 'buy' | 'sell' | 'neutral' =
              latestEma !== null ? (currentPrice > latestEma ? 'buy' : 'sell') : 'neutral';

            maData[`${p}`] = {
              sma: latestSma,
              ema: latestEma,
              smaSignal: currentPrice > (latestSma ?? 0) ? 'above' : 'below',
              emaSignal: currentPrice > (latestEma ?? 0) ? 'above' : 'below',
            };

            signals.push({
              indicator: `SMA ${p}`,
              signal: smaSignal,
              detail: `Price ${smaSignal === 'buy' ? 'above' : 'below'} ${p}-SMA (${latestSma})`,
            });
            signals.push({
              indicator: `EMA ${p}`,
              signal: emaSignal,
              detail: `Price ${emaSignal === 'buy' ? 'above' : 'below'} ${p}-EMA (${latestEma})`,
            });
          } else {
            maData[`${p}`] = { sma: null, ema: null, smaSignal: 'N/A', emaSignal: 'N/A' };
          }
        }

        // ----- RSI -----
        const rsiValues = rsi(closes, 14);
        let rsiData: { value: number | null; status: string; signal: 'buy' | 'sell' | 'neutral' } = {
          value: null,
          status: 'Insufficient data',
          signal: 'neutral',
        };
        if (rsiValues.length > 0) {
          const currentRsi = roundTo(rsiValues[rsiValues.length - 1], 2);
          let rsiStatus: string;
          let rsiSignal: 'buy' | 'sell' | 'neutral';
          if (currentRsi >= 70) { rsiStatus = 'Overbought'; rsiSignal = 'sell'; }
          else if (currentRsi <= 30) { rsiStatus = 'Oversold'; rsiSignal = 'buy'; }
          else { rsiStatus = 'Neutral'; rsiSignal = 'neutral'; }

          rsiData = { value: currentRsi, status: rsiStatus, signal: rsiSignal };
          signals.push({
            indicator: 'RSI(14)',
            signal: rsiSignal,
            detail: `RSI at ${currentRsi} -- ${rsiStatus}`,
          });
        }

        // ----- MACD -----
        const macdResult = macd(closes, 12, 26, 9);
        let macdData: {
          macd: number | null;
          signal: number | null;
          histogram: number | null;
          crossover: string | null;
          macdSignal: 'buy' | 'sell' | 'neutral';
        } = {
          macd: null,
          signal: null,
          histogram: null,
          crossover: null,
          macdSignal: 'neutral',
        };

        if (macdResult.histogram.length >= 2) {
          const currentMacdVal = roundTo(macdResult.macdLine[macdResult.macdLine.length - 1], 4);
          const currentSignalVal = roundTo(macdResult.signalLine[macdResult.signalLine.length - 1], 4);
          const currentHist = roundTo(macdResult.histogram[macdResult.histogram.length - 1], 4);
          const prevHist = macdResult.histogram[macdResult.histogram.length - 2];

          let crossover: string | null = null;
          let macdSignal: 'buy' | 'sell' | 'neutral' = 'neutral';
          if (prevHist <= 0 && currentHist > 0) {
            crossover = 'Bullish crossover';
            macdSignal = 'buy';
          } else if (prevHist >= 0 && currentHist < 0) {
            crossover = 'Bearish crossover';
            macdSignal = 'sell';
          } else if (currentHist > 0) {
            macdSignal = 'buy';
          } else if (currentHist < 0) {
            macdSignal = 'sell';
          }

          macdData = {
            macd: currentMacdVal,
            signal: currentSignalVal,
            histogram: currentHist,
            crossover,
            macdSignal,
          };

          signals.push({
            indicator: 'MACD(12,26,9)',
            signal: macdSignal,
            detail: `MACD: ${currentMacdVal}, Signal: ${currentSignalVal}, Hist: ${currentHist}${crossover ? ` (${crossover})` : ''}`,
          });
        }

        // ----- BOLLINGER BANDS -----
        const bbPeriod = 20;
        let bollingerData: {
          upper: number | null;
          middle: number | null;
          lower: number | null;
          position: string;
          bbSignal: 'buy' | 'sell' | 'neutral';
        } = {
          upper: null,
          middle: null,
          lower: null,
          position: 'Insufficient data',
          bbSignal: 'neutral',
        };

        if (closes.length >= bbPeriod) {
          const smaValues = sma(closes, bbPeriod);
          const middle = smaValues[smaValues.length - 1];

          // Standard deviation of the last bbPeriod values
          const recentCloses = closes.slice(-bbPeriod);
          const mean = recentCloses.reduce((a, b) => a + b, 0) / bbPeriod;
          const variance = recentCloses.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / bbPeriod;
          const stdDev = Math.sqrt(variance);

          const upper = roundTo(middle + 2 * stdDev, 2);
          const lower = roundTo(middle - 2 * stdDev, 2);
          const middleRounded = roundTo(middle, 2);

          let position: string;
          let bbSignal: 'buy' | 'sell' | 'neutral';
          if (currentPrice >= upper) {
            position = 'Above upper band (potentially overbought)';
            bbSignal = 'sell';
          } else if (currentPrice <= lower) {
            position = 'Below lower band (potentially oversold)';
            bbSignal = 'buy';
          } else if (currentPrice > middleRounded) {
            position = 'Between middle and upper band';
            bbSignal = 'neutral';
          } else {
            position = 'Between lower and middle band';
            bbSignal = 'neutral';
          }

          bollingerData = { upper, middle: middleRounded, lower, position, bbSignal };
          signals.push({
            indicator: 'Bollinger Bands(20,2)',
            signal: bbSignal,
            detail: `Price at ${currentPrice}, BB: ${lower} / ${middleRounded} / ${upper} -- ${position}`,
          });
        }

        // ----- VOLUME TREND -----
        let volumeData: {
          currentVolume: number;
          avg20Volume: number;
          volumeRatio: number;
          trend: string;
          volumeSignal: 'buy' | 'sell' | 'neutral';
        } | null = null;

        if (volumes.length >= 20) {
          const currentVol = volumes[volumes.length - 1];
          const avg20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
          const ratio = avg20 > 0 ? roundTo(currentVol / avg20, 2) : 0;

          // Check if volume is rising or falling over last 5 days vs previous 5
          const recent5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
          const prev5 = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;

          let trend: string;
          let volumeSignal: 'buy' | 'sell' | 'neutral' = 'neutral';
          if (recent5 > prev5 * 1.2) {
            trend = 'Rising (recent volume above 20-day average)';
            // Rising volume on up-move is bullish, on down-move is bearish
            const priceUp = closes[closes.length - 1] > closes[closes.length - 6];
            volumeSignal = priceUp ? 'buy' : 'sell';
          } else if (recent5 < prev5 * 0.8) {
            trend = 'Falling (recent volume below 20-day average)';
            volumeSignal = 'neutral';
          } else {
            trend = 'Stable (near 20-day average)';
            volumeSignal = 'neutral';
          }

          volumeData = {
            currentVolume: currentVol,
            avg20Volume: roundTo(avg20, 0),
            volumeRatio: ratio,
            trend,
            volumeSignal,
          };

          signals.push({
            indicator: 'Volume',
            signal: volumeSignal,
            detail: `Volume ratio: ${ratio}x avg -- ${trend}`,
          });
        }

        // ----- SUPPORT / RESISTANCE -----
        const sr = findSupportResistance(closes, highs, lows);

        // ----- OVERALL SIGNAL -----
        const overall = computeOverallSignal(signals);

        const result = {
          ticker: normalized,
          currentPrice,
          dataPointsUsed: closes.length,
          latestDate: String(rows[rows.length - 1].trade_date).slice(0, 10),
          movingAverages: maData,
          rsi: rsiData,
          macd: macdData,
          bollingerBands: bollingerData,
          volume: volumeData,
          supportResistance: sr,
          signals,
          overall: {
            rating: overall.rating,
            score: overall.score,
            breakdown: `${overall.buyCount} buy, ${overall.sellCount} sell, ${overall.neutralCount} neutral out of ${signals.length} indicators`,
          },
        };

        await cacheSet(key, result, TECH_TTL);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${normalized} Technical Summary: ${overall.rating} (score ${overall.score}) | RSI: ${rsiData.value ?? 'N/A'} | MACD: ${macdData.crossover ?? 'No crossover'} | Price: ${currentPrice}`,
              data: result,
              context: {
                ticker: normalized,
                units: {
                  price: 'INR',
                  rsi: 'Scale 0-100',
                  volume: 'Shares',
                  macd: 'Price difference',
                },
                disclaimer: 'Technical analysis is based on historical price patterns and does not guarantee future performance. Use in conjunction with fundamental analysis.',
              },
              relatedTools: [
                'get_price_history',
                'get_company_profile',
                'get_valuation_metrics',
                'calculate_dcf',
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_technical_summary',
              err instanceof Error ? err.message : 'Technical summary failed'
            ),
          }],
        };
      }
    }
  );
}
