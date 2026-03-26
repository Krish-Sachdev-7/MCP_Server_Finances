/**
 * Portfolio tools -- create_watchlist, analyze_portfolio, get_portfolio_returns,
 * suggest_rebalancing.
 *
 * Phase 3 implementation -- follows the exact pattern from src/tools/company.ts.
 *
 * IMPORTANT: Portfolio tools receive holdings as input on every call. Holdings are
 * NOT stored server-side. Only watchlists (ticker lists) are persisted to the database.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from '../db/connection.js';
import type { RedisClient } from '../cache/redis.js';
import * as queries from '../db/queries.js';
import {
  buildResponse,
  buildErrorResponse,
  normalizeTicker,
} from '../utils/response-builder.js';
import { xirr, cagr } from '../utils/financial-math.js';

// ============================================================
// HELPERS
// ============================================================

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isFinite(n) ? n : 0;
}

function roundTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

/** Shared holding analysis logic used by analyze_portfolio and suggest_rebalancing. */
interface HoldingInput {
  ticker: string;
  quantity: number;
  avgPrice: number;
}

interface AnalyzedHolding {
  ticker: string;
  name: string;
  sector: string | null;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  value: number;
  costBasis: number;
  weight: number;
  gainLoss: number;
  returnPercent: number;
}

interface PortfolioAnalysis {
  totalValue: number;
  totalCostBasis: number;
  totalGainLoss: number;
  totalReturnPercent: number;
  dayChange: number;
  dayChangePercent: number;
  sectorExposure: Record<string, number>;
  concentrationRisk: { hhi: number; level: string };
  largestPosition: { ticker: string; weight: number };
  diversificationScore: number;
  holdingDetails: AnalyzedHolding[];
  warnings: string[];
}

async function analyzeHoldings(
  db: Pool,
  holdings: HoldingInput[]
): Promise<PortfolioAnalysis> {
  const warnings: string[] = [];
  const holdingDetails: AnalyzedHolding[] = [];
  let totalValue = 0;
  let totalCostBasis = 0;
  let dayChange = 0;

  for (const h of holdings) {
    const normalized = normalizeTicker(h.ticker);
    const company = await queries.getCompanyByTicker(db, normalized);
    if (!company) {
      warnings.push(`Ticker "${normalized}" not found in database -- excluded from analysis.`);
      continue;
    }

    const latestPrice = await queries.getLatestPrice(db, company.id);
    if (!latestPrice) {
      warnings.push(`No price data for "${normalized}" -- excluded from analysis.`);
      continue;
    }

    const currentPrice = toNum(latestPrice.close_price);
    const value = h.quantity * currentPrice;
    const costBasis = h.quantity * h.avgPrice;
    const gainLoss = value - costBasis;
    const returnPercent = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;

    // Day change: fetch previous close to calculate
    const { rows: prevRows } = await db.query(
      `SELECT close_price FROM price_history
       WHERE company_id = $1 AND trade_date < $2
       ORDER BY trade_date DESC LIMIT 1`,
      [company.id, latestPrice.trade_date]
    );
    const prevClose = prevRows[0] ? toNum(prevRows[0].close_price) : currentPrice;
    const holdingDayChange = (currentPrice - prevClose) * h.quantity;
    dayChange += holdingDayChange;

    totalValue += value;
    totalCostBasis += costBasis;

    holdingDetails.push({
      ticker: normalized,
      name: company.company_name,
      sector: company.sector ?? null,
      quantity: h.quantity,
      avgPrice: h.avgPrice,
      currentPrice,
      value: roundTo(value, 2),
      costBasis: roundTo(costBasis, 2),
      weight: 0, // computed below once totalValue is known
      gainLoss: roundTo(gainLoss, 2),
      returnPercent: roundTo(returnPercent, 2),
    });
  }

  // Compute weights now that totalValue is known
  for (const hd of holdingDetails) {
    hd.weight = totalValue > 0 ? roundTo((hd.value / totalValue) * 100, 2) : 0;
  }

  // Sector exposure
  const sectorExposure: Record<string, number> = {};
  for (const hd of holdingDetails) {
    const sec = hd.sector ?? 'Unknown';
    sectorExposure[sec] = (sectorExposure[sec] || 0) + (totalValue > 0 ? hd.value / totalValue : 0);
  }
  for (const sec of Object.keys(sectorExposure)) {
    sectorExposure[sec] = roundTo(sectorExposure[sec] * 100, 2);
  }

  // Concentration risk via HHI
  let hhi = 0;
  for (const hd of holdingDetails) {
    const w = totalValue > 0 ? hd.value / totalValue : 0;
    hhi += (w * 100) * (w * 100); // HHI scale: 0 to 10000
  }
  hhi = Math.round(hhi);
  const level = hhi < 1500 ? 'diversified' : hhi < 2500 ? 'moderate' : 'concentrated';

  // Largest position
  const sorted = [...holdingDetails].sort((a, b) => b.weight - a.weight);
  const largestPosition = sorted.length > 0
    ? { ticker: sorted[0].ticker, weight: sorted[0].weight }
    : { ticker: 'N/A', weight: 0 };

  // Diversification score: 0 (single stock) to ~100 (many equal-weight positions)
  const diversificationScore = Math.max(0, Math.min(100, roundTo(100 - (hhi / 100), 1)));

  const totalGainLoss = totalValue - totalCostBasis;
  const totalReturnPercent = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;
  const dayChangePercent = totalValue > 0 ? (dayChange / (totalValue - dayChange)) * 100 : 0;

  return {
    totalValue: roundTo(totalValue, 2),
    totalCostBasis: roundTo(totalCostBasis, 2),
    totalGainLoss: roundTo(totalGainLoss, 2),
    totalReturnPercent: roundTo(totalReturnPercent, 2),
    dayChange: roundTo(dayChange, 2),
    dayChangePercent: roundTo(dayChangePercent, 2),
    sectorExposure,
    concentrationRisk: { hhi, level },
    largestPosition,
    diversificationScore,
    holdingDetails,
    warnings,
  };
}

export function registerTools(
  server: McpServer,
  db: Pool,
  _cache: RedisClient
): void {

  // ------------------------------------------------------------------
  // create_watchlist
  // ------------------------------------------------------------------
  server.tool(
    'create_watchlist',
    'Create or update a named watchlist of Indian stock tickers. If a watchlist with ' +
    'the same name already exists, its tickers are replaced entirely. Watchlists persist ' +
    'across sessions. Use this to save lists of stocks for monitoring. ' +
    'Example: create_watchlist({ name: "IT picks", tickers: ["TCS", "INFY", "WIPRO"] })',
    {
      name: z.string().min(1).max(100).describe(
        'Name for the watchlist, e.g. "My portfolio", "Banking watchlist"'
      ),
      tickers: z.array(z.string().min(1)).min(1).max(100).describe(
        'Array of ticker symbols to include, e.g. ["TCS", "INFY", "RELIANCE"]'
      ),
    },
    async ({ name, tickers }) => {
      try {
        const normalizedTickers = tickers.map(normalizeTicker);
        const clientId = 'default';

        await db.query(
          `INSERT INTO watchlists (client_id, name, tickers)
           VALUES ($1, $2, $3)
           ON CONFLICT (client_id, name)
           DO UPDATE SET tickers = $3, updated_at = NOW()`,
          [clientId, name, normalizedTickers]
        );

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Watchlist "${name}" saved with ${normalizedTickers.length} ticker(s).`,
              data: {
                name,
                tickers: normalizedTickers,
                tickerCount: normalizedTickers.length,
              },
              context: {
                note: 'Watchlist persists across sessions. Creating a watchlist with the same name will replace the previous tickers.',
              },
              relatedTools: ['search_companies', 'get_company_profile', 'analyze_portfolio'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'create_watchlist',
              err instanceof Error ? err.message : 'Watchlist creation failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // analyze_portfolio
  // ------------------------------------------------------------------
  server.tool(
    'analyze_portfolio',
    'Analyze a stock portfolio: compute total value, gain/loss, day change, sector ' +
    'exposure, concentration risk (HHI), diversification score, and per-holding details. ' +
    'Pass holdings as input -- nothing is stored server-side. Validates tickers against ' +
    'the database and warns about unrecognized ones. Max 50 holdings. ' +
    'Example: analyze_portfolio({ holdings: [{ ticker: "TCS", quantity: 100, avgPrice: 3500 }] })',
    {
      holdings: z.array(z.object({
        ticker: z.string().min(1).describe('Ticker symbol'),
        quantity: z.number().min(0.01).describe('Number of shares held'),
        avgPrice: z.number().min(0).describe('Average purchase price per share in INR'),
      })).min(1).max(50).describe('Array of portfolio holdings'),
    },
    async ({ holdings }) => {
      try {
        const analysis = await analyzeHoldings(db, holdings);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Portfolio: ${analysis.holdingDetails.length} holding(s), value: ${analysis.totalValue} INR, return: ${analysis.totalReturnPercent >= 0 ? '+' : ''}${analysis.totalReturnPercent}%, concentration: ${analysis.concentrationRisk.level}.${analysis.warnings.length > 0 ? ` ${analysis.warnings.length} warning(s).` : ''}`,
              data: analysis,
              context: {
                units: {
                  values: 'INR',
                  weights: 'Percentage (%)',
                  hhi: '0-10000 scale (< 1500 diversified, 1500-2500 moderate, > 2500 concentrated)',
                },
                note: 'Holdings are provided as input and not stored. Day change is based on the most recent two trading days available.',
              },
              relatedTools: [
                'get_portfolio_returns',
                'suggest_rebalancing',
                'get_sector_overview',
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'analyze_portfolio',
              err instanceof Error ? err.message : 'Portfolio analysis failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_portfolio_returns
  // ------------------------------------------------------------------
  server.tool(
    'get_portfolio_returns',
    'Compute portfolio returns including XIRR (annualized return), absolute return, ' +
    'holding period, per-stock CAGR, and benchmark comparison (vs Nifty 50 by default). ' +
    'Requires buy dates for each holding to compute time-weighted returns. ' +
    'Example: get_portfolio_returns({ holdings: [{ ticker: "RELIANCE", quantity: 50, buyDate: "2023-01-15", avgPrice: 2400 }] })',
    {
      holdings: z.array(z.object({
        ticker: z.string().min(1).describe('Ticker symbol'),
        quantity: z.number().min(0.01).describe('Number of shares'),
        buyDate: z.string().describe('Purchase date in YYYY-MM-DD format'),
        avgPrice: z.number().min(0).describe('Average purchase price per share in INR'),
      })).min(1).max(50).describe('Array of holdings with buy dates'),
      benchmarkIndex: z.string().optional().describe(
        'Benchmark index name for comparison (default "NIFTY 50")'
      ),
    },
    async ({ holdings, benchmarkIndex }) => {
      try {
        const benchmark = benchmarkIndex ?? 'NIFTY 50';
        const warnings: string[] = [];
        const cashFlows: { amount: number; date: Date }[] = [];
        const perStockReturns: Array<Record<string, unknown>> = [];
        let totalCost = 0;
        let totalCurrentValue = 0;
        let earliestDate: Date | null = null;

        for (const h of holdings) {
          const normalized = normalizeTicker(h.ticker);
          const company = await queries.getCompanyByTicker(db, normalized);
          if (!company) {
            warnings.push(`Ticker "${normalized}" not found -- excluded.`);
            continue;
          }

          const latestPrice = await queries.getLatestPrice(db, company.id);
          if (!latestPrice) {
            warnings.push(`No price data for "${normalized}" -- excluded.`);
            continue;
          }

          const currentPrice = toNum(latestPrice.close_price);
          const buyDate = new Date(h.buyDate);
          if (isNaN(buyDate.getTime())) {
            warnings.push(`Invalid buyDate for "${normalized}": "${h.buyDate}" -- excluded.`);
            continue;
          }

          const cost = h.quantity * h.avgPrice;
          const currentVal = h.quantity * currentPrice;
          totalCost += cost;
          totalCurrentValue += currentVal;

          // Cash flows for XIRR: outflow on buy, inflow today
          cashFlows.push({ amount: -cost, date: buyDate });

          if (!earliestDate || buyDate < earliestDate) {
            earliestDate = buyDate;
          }

          // Per-stock return
          const holdingDays = (Date.now() - buyDate.getTime()) / 86400000;
          const holdingYears = holdingDays / 365.25;
          const absReturn = cost > 0 ? ((currentVal - cost) / cost) * 100 : 0;
          const stockCagr = cagr(cost, currentVal, holdingYears);

          perStockReturns.push({
            ticker: normalized,
            buyDate: h.buyDate,
            avgPrice: h.avgPrice,
            currentPrice: roundTo(currentPrice, 2),
            absoluteReturnPct: roundTo(absReturn, 2),
            cagrPct: stockCagr !== null ? roundTo(stockCagr * 100, 2) : null,
          });
        }

        // Add final inflow (total current value as of today) for XIRR
        if (totalCurrentValue > 0) {
          cashFlows.push({ amount: totalCurrentValue, date: new Date() });
        }

        // Sort cash flows by date for XIRR
        cashFlows.sort((a, b) => a.date.getTime() - b.date.getTime());

        const portfolioXirr = cashFlows.length >= 2 ? xirr(cashFlows) : null;
        const absoluteReturn = totalCost > 0 ? ((totalCurrentValue - totalCost) / totalCost) * 100 : 0;
        const holdingPeriodDays = earliestDate
          ? Math.round((Date.now() - earliestDate.getTime()) / 86400000)
          : 0;

        // Benchmark comparison: approximate using index constituents' average return
        let benchmarkReturn: number | null = null;
        let alpha: number | null = null;
        if (earliestDate) {
          const daysBack = holdingPeriodDays;
          const { rows: benchRows } = await db.query(
            `WITH bench_companies AS (
              SELECT ic.company_id
              FROM index_constituents ic
              WHERE ic.index_name = $1 AND ic.is_current = TRUE
              LIMIT 30
            ),
            bench_latest AS (
              SELECT DISTINCT ON (ph.company_id)
                ph.company_id, ph.close_price
              FROM price_history ph
              JOIN bench_companies bc ON ph.company_id = bc.company_id
              ORDER BY ph.company_id, ph.trade_date DESC
            ),
            bench_earlier AS (
              SELECT DISTINCT ON (ph.company_id)
                ph.company_id, ph.close_price AS earlier_close
              FROM price_history ph
              JOIN bench_companies bc ON ph.company_id = bc.company_id
              WHERE ph.trade_date <= CURRENT_DATE - $2::INTEGER
              ORDER BY ph.company_id, ph.trade_date DESC
            )
            SELECT
              AVG(CASE WHEN be.earlier_close > 0
                THEN (bl.close_price - be.earlier_close) / be.earlier_close * 100
                ELSE NULL END) AS avg_return
            FROM bench_latest bl
            JOIN bench_earlier be ON bl.company_id = be.company_id`,
            [benchmark, daysBack]
          );

          if (benchRows[0] && benchRows[0].avg_return !== null) {
            benchmarkReturn = roundTo(toNum(benchRows[0].avg_return), 2);
            if (portfolioXirr !== null) {
              // Annualize the benchmark return for comparison
              const benchYears = holdingPeriodDays / 365.25;
              const benchAnnualized = benchYears > 0
                ? (Math.pow(1 + benchmarkReturn / 100, 1 / benchYears) - 1) * 100
                : benchmarkReturn;
              alpha = roundTo(portfolioXirr * 100 - benchAnnualized, 2);
            }
          }
        }

        const result = {
          xirrPct: portfolioXirr !== null ? roundTo(portfolioXirr * 100, 2) : null,
          absoluteReturnPct: roundTo(absoluteReturn, 2),
          holdingPeriodDays,
          totalCost: roundTo(totalCost, 2),
          totalCurrentValue: roundTo(totalCurrentValue, 2),
          benchmark,
          benchmarkReturnPct: benchmarkReturn,
          alphaPct: alpha,
          perStockReturns,
          warnings,
        };

        const xirrStr = result.xirrPct !== null ? `XIRR: ${result.xirrPct}%` : 'XIRR: insufficient data';
        const benchStr = benchmarkReturn !== null
          ? `Benchmark (${benchmark}): ${benchmarkReturn >= 0 ? '+' : ''}${benchmarkReturn}%`
          : `Benchmark: data not available`;

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Portfolio returns over ${holdingPeriodDays} days. ${xirrStr}. Absolute: ${roundTo(absoluteReturn, 2)}%. ${benchStr}.${warnings.length > 0 ? ` ${warnings.length} warning(s).` : ''}`,
              data: result,
              context: {
                units: { returns: 'Percentage (%)', values: 'INR' },
                note: 'XIRR accounts for the timing and size of each investment. Benchmark return is an approximate average of index constituent returns over the same period. Alpha = portfolio XIRR minus annualized benchmark return.',
              },
              relatedTools: ['analyze_portfolio', 'suggest_rebalancing', 'get_price_history'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_portfolio_returns',
              err instanceof Error ? err.message : 'Portfolio returns calculation failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // suggest_rebalancing
  // ------------------------------------------------------------------
  server.tool(
    'suggest_rebalancing',
    'Generate rebalancing suggestions for a stock portfolio based on concentration risk, ' +
    'sector overweights, and loss positions. Optionally provide target sector weights for ' +
    'tactical allocation comparison. Returns prioritized actionable suggestions. ' +
    'Example: suggest_rebalancing({ holdings: [{ ticker: "TCS", quantity: 100, avgPrice: 3500 }] })',
    {
      holdings: z.array(z.object({
        ticker: z.string().min(1).describe('Ticker symbol'),
        quantity: z.number().min(0.01).describe('Number of shares held'),
        avgPrice: z.number().min(0).describe('Average purchase price per share in INR'),
      })).min(1).max(50).describe('Array of portfolio holdings'),
      targetSectorWeights: z.record(z.string(), z.number()).optional().describe(
        'Optional target sector allocation as decimal weights, e.g. { "Information Technology": 30, "Financial Services": 25 }. Values in percentage.'
      ),
    },
    async ({ holdings, targetSectorWeights }) => {
      try {
        const analysis = await analyzeHoldings(db, holdings);
        const suggestions: Array<{
          type: string;
          ticker?: string;
          sector?: string;
          detail: string;
          priority: string;
        }> = [];

        // Rule 1: Single stock > 20% weight
        for (const hd of analysis.holdingDetails) {
          if (hd.weight > 20) {
            suggestions.push({
              type: 'trim',
              ticker: hd.ticker,
              detail: `${hd.ticker} is ${hd.weight}% of portfolio. Consider trimming to below 20% to reduce single-stock risk.`,
              priority: hd.weight > 30 ? 'high' : 'medium',
            });
          }
        }

        // Rule 2: Sector > 40% weight
        for (const [sector, weight] of Object.entries(analysis.sectorExposure)) {
          if (weight > 40) {
            suggestions.push({
              type: 'sector_overweight',
              sector,
              detail: `${sector} is ${weight}% of portfolio. Consider diversifying into other sectors to reduce sector concentration.`,
              priority: weight > 50 ? 'high' : 'medium',
            });
          }
        }

        // Rule 3: Holdings with > 30% loss
        for (const hd of analysis.holdingDetails) {
          if (hd.returnPercent < -30) {
            suggestions.push({
              type: 'loss_review',
              ticker: hd.ticker,
              detail: `${hd.ticker} is down ${Math.abs(hd.returnPercent)}% from purchase price. Review whether the original investment thesis still holds.`,
              priority: hd.returnPercent < -50 ? 'high' : 'medium',
            });
          }
        }

        // Rule 4: Target sector comparison (if provided)
        if (targetSectorWeights) {
          for (const [sector, targetWeight] of Object.entries(targetSectorWeights)) {
            const actual = analysis.sectorExposure[sector] ?? 0;
            const diff = actual - targetWeight;
            if (Math.abs(diff) >= 5) {
              if (diff > 0) {
                suggestions.push({
                  type: 'rebalance',
                  sector,
                  detail: `${sector} is overweight: ${roundTo(actual, 1)}% actual vs ${targetWeight}% target. Consider reducing exposure by ${roundTo(diff, 1)}pp.`,
                  priority: Math.abs(diff) > 15 ? 'high' : 'low',
                });
              } else {
                suggestions.push({
                  type: 'rebalance',
                  sector,
                  detail: `${sector} is underweight: ${roundTo(actual, 1)}% actual vs ${targetWeight}% target. Consider increasing exposure by ${roundTo(Math.abs(diff), 1)}pp.`,
                  priority: Math.abs(diff) > 15 ? 'high' : 'low',
                });
              }
            }
          }
        }

        // Sort by priority
        const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        suggestions.sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));

        // Overall health rating
        let healthRating: string;
        if (suggestions.filter(s => s.priority === 'high').length >= 2) {
          healthRating = 'high concentration risk';
        } else if (suggestions.length === 0) {
          healthRating = 'well-diversified';
        } else {
          healthRating = 'needs attention';
        }

        const result = {
          suggestions,
          summary: {
            suggestionCount: suggestions.length,
            healthRating,
          },
          currentExposure: analysis.sectorExposure,
          targetExposure: targetSectorWeights ?? null,
          concentrationRisk: analysis.concentrationRisk,
          diversificationScore: analysis.diversificationScore,
          warnings: analysis.warnings,
        };

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${suggestions.length} rebalancing suggestion(s). Portfolio health: ${healthRating}. Diversification score: ${analysis.diversificationScore}/100.${analysis.warnings.length > 0 ? ` ${analysis.warnings.length} warning(s).` : ''}`,
              data: result,
              context: {
                note: 'Suggestions are rules-based (position > 20%, sector > 40%, loss > 30%). They are not investment advice. Adjust thresholds and targets to match your risk tolerance.',
              },
              relatedTools: ['analyze_portfolio', 'get_portfolio_returns', 'get_sector_overview'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'suggest_rebalancing',
              err instanceof Error ? err.message : 'Rebalancing analysis failed'
            ),
          }],
        };
      }
    }
  );
}
