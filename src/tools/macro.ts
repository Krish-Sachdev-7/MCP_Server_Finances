/**
 * Macro / market-level tools -- get_market_overview, get_macro_indicators,
 * get_fii_dii_flows, get_sector_rotation.
 *
 * Phase 3 implementation -- follows the exact pattern from src/tools/company.ts.
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
} from '../utils/response-builder.js';

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

function toNumOrNull(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isFinite(n) ? n : null;
}

const PERIOD_DAYS: Record<string, number> = {
  '1w': 7,
  '1m': 30,
  '3m': 90,
};

export function registerTools(
  server: McpServer,
  db: Pool,
  _cache: RedisClient
): void {

  // ------------------------------------------------------------------
  // get_market_overview
  // ------------------------------------------------------------------
  server.tool(
    'get_market_overview',
    'Get a real-time snapshot of the Indian equity market: key index levels (Nifty 50, ' +
    'Sensex, Bank Nifty, Nifty IT), market breadth (advances/declines), FII/DII net ' +
    'flows, top 5 gainers and losers by percentage change, and VIX if available. ' +
    'Takes no parameters. Use this as the starting point for any market analysis. ' +
    'Example: get_market_overview({})',
    {},
    async () => {
      try {
        const key = cacheKey('macro', 'overview');
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: 'Market overview (cached)',
                data: cached,
                context: {},
                relatedTools: ['get_macro_indicators', 'get_fii_dii_flows', 'get_sector_rotation'],
              }),
            }],
          };
        }

        // 1. Index proxies: compute simple average return for key index constituents
        const indexNames = ['NIFTY 50', 'SENSEX', 'NIFTY BANK', 'NIFTY IT'];
        const indices: Record<string, { avgClose: number; dayChangePct: number; constituents: number } | null> = {};

        for (const idxName of indexNames) {
          const { rows } = await db.query(
            `WITH latest_prices AS (
              SELECT DISTINCT ON (ph.company_id)
                ph.company_id, ph.close_price, ph.trade_date
              FROM price_history ph
              JOIN index_constituents ic ON ph.company_id = ic.company_id
              WHERE ic.index_name = $1 AND ic.is_current = TRUE
              ORDER BY ph.company_id, ph.trade_date DESC
            ),
            prev_prices AS (
              SELECT DISTINCT ON (ph.company_id)
                ph.company_id, ph.close_price AS prev_close
              FROM price_history ph
              JOIN index_constituents ic ON ph.company_id = ic.company_id
              WHERE ic.index_name = $1 AND ic.is_current = TRUE
                AND ph.trade_date < (SELECT MAX(trade_date) FROM price_history)
              ORDER BY ph.company_id, ph.trade_date DESC
            )
            SELECT
              AVG(lp.close_price) AS avg_close,
              AVG(CASE WHEN pp.prev_close > 0
                THEN (lp.close_price - pp.prev_close) / pp.prev_close * 100
                ELSE NULL END) AS avg_day_change_pct,
              COUNT(*) AS cnt
            FROM latest_prices lp
            LEFT JOIN prev_prices pp ON lp.company_id = pp.company_id`,
            [idxName]
          );

          if (rows[0] && toNum(rows[0].cnt) > 0) {
            indices[idxName] = {
              avgClose: roundTo(toNum(rows[0].avg_close), 2),
              dayChangePct: roundTo(toNum(rows[0].avg_day_change_pct), 2),
              constituents: toNum(rows[0].cnt),
            };
          } else {
            indices[idxName] = null;
          }
        }

        // 2. Market breadth: advances vs declines across all active companies
        const { rows: breadthRows } = await db.query(
          `WITH latest_two AS (
            SELECT company_id, close_price, trade_date,
              ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY trade_date DESC) AS rn
            FROM price_history
            WHERE trade_date >= CURRENT_DATE - 7
          )
          SELECT
            COUNT(*) FILTER (WHERE curr.close_price > prev.close_price) AS advances,
            COUNT(*) FILTER (WHERE curr.close_price < prev.close_price) AS declines,
            COUNT(*) FILTER (WHERE curr.close_price = prev.close_price) AS unchanged
          FROM (SELECT * FROM latest_two WHERE rn = 1) curr
          JOIN (SELECT * FROM latest_two WHERE rn = 2) prev
            ON curr.company_id = prev.company_id`
        );

        const breadth = {
          advances: toNum(breadthRows[0]?.advances),
          declines: toNum(breadthRows[0]?.declines),
          unchanged: toNum(breadthRows[0]?.unchanged),
        };

        // 3. FII/DII flows from latest macro_indicators row
        const macroRows = await queries.getMacroIndicators(db, 1);
        const latestMacro = macroRows[0] as Record<string, unknown> | undefined;
        const flows = {
          fiiNetBuyCr: toNumOrNull(latestMacro?.fii_net_buy_cr),
          diiNetBuyCr: toNumOrNull(latestMacro?.dii_net_buy_cr),
          asOfDate: latestMacro?.indicator_date ?? null,
        };

        // 4. Top gainers and losers
        const { rows: movers } = await db.query(
          `WITH latest_two AS (
            SELECT ph.company_id, ph.close_price, ph.trade_date,
              ROW_NUMBER() OVER (PARTITION BY ph.company_id ORDER BY ph.trade_date DESC) AS rn
            FROM price_history ph
            JOIN companies c ON ph.company_id = c.id AND c.is_active = TRUE
            WHERE ph.trade_date >= CURRENT_DATE - 7
          ),
          changes AS (
            SELECT curr.company_id,
              curr.close_price AS current_close,
              prev.close_price AS prev_close,
              CASE WHEN prev.close_price > 0
                THEN (curr.close_price - prev.close_price) / prev.close_price * 100
                ELSE NULL END AS pct_change
            FROM (SELECT * FROM latest_two WHERE rn = 1) curr
            JOIN (SELECT * FROM latest_two WHERE rn = 2) prev
              ON curr.company_id = prev.company_id
            WHERE prev.close_price > 0
          )
          SELECT c.ticker, c.company_name, ch.current_close, ch.pct_change
          FROM changes ch
          JOIN companies c ON ch.company_id = c.id
          ORDER BY ch.pct_change DESC`
        );

        const topGainers = movers.slice(0, 5).map((r: Record<string, unknown>) => ({
          ticker: r.ticker,
          name: r.company_name,
          close: roundTo(toNum(r.current_close), 2),
          percentChange: roundTo(toNum(r.pct_change), 2),
        }));

        const topLosers = movers.slice(-5).reverse().map((r: Record<string, unknown>) => ({
          ticker: r.ticker,
          name: r.company_name,
          close: roundTo(toNum(r.current_close), 2),
          percentChange: roundTo(toNum(r.pct_change), 2),
        }));

        const result = {
          indices,
          breadth,
          flows,
          topGainers,
          topLosers,
          vix: null as number | null, // VIX not available in current schema
        };

        await cacheSet(key, result, 300); // 5 min TTL

        const nifty = indices['NIFTY 50'];
        const summaryParts: string[] = [];
        if (nifty) summaryParts.push(`Nifty 50 avg constituent close: ${nifty.avgClose} (${nifty.dayChangePct >= 0 ? '+' : ''}${nifty.dayChangePct}%)`);
        summaryParts.push(`Breadth: ${breadth.advances} advances, ${breadth.declines} declines`);
        if (flows.fiiNetBuyCr !== null) summaryParts.push(`FII net: ${flows.fiiNetBuyCr} Cr`);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: summaryParts.join('. ') + '.',
              data: result,
              context: {
                note: 'Index values are simple averages of constituent close prices, not official index levels. Day change is average percentage change across constituents.',
                units: { prices: 'INR', flows: 'INR Crores', percentChange: '%' },
              },
              relatedTools: ['get_macro_indicators', 'get_fii_dii_flows', 'get_sector_rotation'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_market_overview',
              err instanceof Error ? err.message : 'Market overview failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_macro_indicators
  // ------------------------------------------------------------------
  server.tool(
    'get_macro_indicators',
    'Get a time series of Indian macroeconomic indicators: RBI repo/reverse repo rate, ' +
    'CPI/WPI inflation, GDP growth, IIP growth, PMI manufacturing/services, USD/INR rate, ' +
    'crude oil price, and gold price. Returns monthly data points sorted newest first. ' +
    'Use this for macro environment analysis and interest rate cycle tracking. ' +
    'Example: get_macro_indicators({ months: 12 })',
    {
      months: z.number().min(1).max(120).optional().describe(
        'Number of months of history to return (default 24, max 120 for 10 years)'
      ),
    },
    async ({ months }) => {
      try {
        const m = months ?? 24;
        const key = cacheKey('macro', 'indicators', { months: m });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Macro indicators -- ${m} months (cached)`,
                data: cached,
                context: {},
                relatedTools: ['get_fii_dii_flows', 'get_market_overview'],
              }),
            }],
          };
        }

        const rows = await queries.getMacroIndicators(db, m);

        if (rows.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_macro_indicators',
                'No macro indicator data found.',
                'Data may not have been ingested yet. Run the macro ingestion pipeline first.'
              ),
            }],
          };
        }

        const indicators = rows.map((r: Record<string, unknown>) => ({
          date: r.indicator_date,
          repoRate: toNumOrNull(r.repo_rate),
          reverseRepoRate: toNumOrNull(r.reverse_repo_rate),
          cpiInflation: toNumOrNull(r.cpi_inflation),
          wpiInflation: toNumOrNull(r.wpi_inflation),
          gdpGrowth: toNumOrNull(r.gdp_growth),
          iipGrowth: toNumOrNull(r.iip_growth),
          pmiManufacturing: toNumOrNull(r.pmi_manufacturing),
          pmiServices: toNumOrNull(r.pmi_services),
          usdInrRate: toNumOrNull(r.usd_inr_rate),
          crudeOilUsd: toNumOrNull(r.crude_oil_usd),
          goldInrPer10g: toNumOrNull(r.gold_inr_per_10g),
        }));

        const result = {
          monthsRequested: m,
          dataPointsReturned: indicators.length,
          indicators,
        };

        await cacheSet(key, result, TTL.MACRO_INDICATORS);

        const latest = indicators[0];
        const summaryParts: string[] = [];
        if (latest.repoRate !== null) summaryParts.push(`Repo: ${latest.repoRate}%`);
        if (latest.cpiInflation !== null) summaryParts.push(`CPI: ${latest.cpiInflation}%`);
        if (latest.usdInrRate !== null) summaryParts.push(`USD/INR: ${latest.usdInrRate}`);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${indicators.length} macro data points. Latest: ${summaryParts.join(', ')}.`,
              data: result,
              context: {
                units: { rates: 'Percentage (%)', usdInr: 'INR per USD', crude: 'USD per barrel', gold: 'INR per 10g' },
              },
              relatedTools: ['get_fii_dii_flows', 'get_market_overview'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_macro_indicators',
              err instanceof Error ? err.message : 'Macro indicators lookup failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_fii_dii_flows
  // ------------------------------------------------------------------
  server.tool(
    'get_fii_dii_flows',
    'Get daily FII (Foreign Institutional Investor) and DII (Domestic Institutional ' +
    'Investor) net buying/selling flows for the Indian equity market. Returns daily ' +
    'values, cumulative totals, and a recent trend signal. Use this to gauge ' +
    'institutional sentiment and identify potential market turning points. ' +
    'Example: get_fii_dii_flows({ days: 30 })',
    {
      days: z.number().min(1).max(365).optional().describe(
        'Number of days of flow data to return (default 30, max 365)'
      ),
    },
    async ({ days }) => {
      try {
        const d = days ?? 30;
        const key = cacheKey('macro', 'flows', { days: d });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `FII/DII flows -- ${d} days (cached)`,
                data: cached,
                context: {},
                relatedTools: ['get_macro_indicators', 'get_market_overview', 'get_sector_rotation'],
              }),
            }],
          };
        }

        // Use getMacroIndicators with a month approximation to get enough daily rows
        const monthsNeeded = Math.max(1, Math.ceil(d / 30));
        const rows = await queries.getMacroIndicators(db, monthsNeeded);

        // Filter to only rows within the requested day window and that have flow data
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - d);

        const flowRows = rows.filter((r: Record<string, unknown>) => {
          const rowDate = new Date(String(r.indicator_date));
          return rowDate >= cutoffDate && (r.fii_net_buy_cr !== null || r.dii_net_buy_cr !== null);
        });

        if (flowRows.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_fii_dii_flows',
                `No FII/DII flow data found for the last ${d} days.`,
                'Flow data may not have been ingested or may not be available for recent dates.'
              ),
            }],
          };
        }

        // Build daily array (note: only net values available per schema)
        const daily = flowRows.map((r: Record<string, unknown>) => ({
          date: r.indicator_date,
          fiiNetCr: toNumOrNull(r.fii_net_buy_cr),
          diiNetCr: toNumOrNull(r.dii_net_buy_cr),
          fiiBuyCr: null as number | null,
          fiiSellCr: null as number | null,
          diiBuyCr: null as number | null,
          diiSellCr: null as number | null,
        }));

        // Cumulative totals
        let fiiNetTotal = 0;
        let diiNetTotal = 0;
        for (const row of daily) {
          if (row.fiiNetCr !== null) fiiNetTotal += row.fiiNetCr;
          if (row.diiNetCr !== null) diiNetTotal += row.diiNetCr;
        }

        // Trend based on last 5 days
        const recentDays = daily.slice(0, 5);
        let recentFiiNet = 0;
        let recentCount = 0;
        for (const row of recentDays) {
          if (row.fiiNetCr !== null) {
            recentFiiNet += row.fiiNetCr;
            recentCount++;
          }
        }
        let trend: string;
        if (recentCount === 0) {
          trend = 'Insufficient data';
        } else if (recentFiiNet > 0) {
          trend = 'FII net buying';
        } else if (recentFiiNet < 0) {
          trend = 'FII net selling';
        } else {
          trend = 'Mixed';
        }

        const result = {
          period: `Last ${d} days`,
          dataPoints: daily.length,
          daily,
          cumulative: {
            fiiNetTotalCr: roundTo(fiiNetTotal, 2),
            diiNetTotalCr: roundTo(diiNetTotal, 2),
            combinedNetCr: roundTo(fiiNetTotal + diiNetTotal, 2),
          },
          trend,
        };

        await cacheSet(key, result, 900); // 15 min TTL

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `FII/DII flows over ${daily.length} day(s). FII cumulative: ${roundTo(fiiNetTotal, 0)} Cr, DII cumulative: ${roundTo(diiNetTotal, 0)} Cr. Trend: ${trend}.`,
              data: result,
              context: {
                units: { values: 'INR Crores' },
                note: 'Only net buy/sell values are available. Individual buy/sell breakdowns are null. Positive = net buying, negative = net selling.',
              },
              relatedTools: ['get_macro_indicators', 'get_market_overview', 'get_sector_rotation'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_fii_dii_flows',
              err instanceof Error ? err.message : 'FII/DII flows lookup failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_sector_rotation
  // ------------------------------------------------------------------
  server.tool(
    'get_sector_rotation',
    'Analyze sector-level performance rotation over a given period. Computes average ' +
    'return per sector from constituent stock price changes and ranks sectors from ' +
    'strongest to weakest. Signals inflow (>5%), outflow (<-5%), or neutral for each ' +
    'sector. Use this to identify momentum shifts and sector allocation opportunities. ' +
    'Example: get_sector_rotation({ period: "1m" })',
    {
      period: z.enum(['1w', '1m', '3m']).describe(
        'Lookback period: "1w" (1 week), "1m" (1 month), or "3m" (3 months)'
      ),
    },
    async ({ period }) => {
      try {
        const days = PERIOD_DAYS[period] ?? 30;
        const key = cacheKey('macro', 'rotation', { period });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Sector rotation -- ${period} (cached)`,
                data: cached,
                context: {},
                relatedTools: ['get_market_overview', 'get_sector_overview', 'run_screen'],
              }),
            }],
          };
        }

        // Adjust signal thresholds based on period length
        const inflowThreshold = period === '1w' ? 2 : period === '1m' ? 5 : 10;
        const outflowThreshold = -inflowThreshold;

        const { rows } = await db.query(
          `WITH sector_returns AS (
            SELECT c.sector,
                   c.ticker,
                   latest.close_price AS current_close,
                   earlier.close_price AS earlier_close,
                   CASE WHEN earlier.close_price > 0
                     THEN (latest.close_price - earlier.close_price) / earlier.close_price * 100
                     ELSE NULL
                   END AS return_pct
            FROM companies c
            JOIN LATERAL (
              SELECT close_price FROM price_history
              WHERE company_id = c.id ORDER BY trade_date DESC LIMIT 1
            ) latest ON TRUE
            JOIN LATERAL (
              SELECT close_price FROM price_history
              WHERE company_id = c.id AND trade_date <= CURRENT_DATE - $1::INTEGER
              ORDER BY trade_date DESC LIMIT 1
            ) earlier ON TRUE
            WHERE c.is_active = TRUE
              AND c.sector IS NOT NULL
              AND c.market_cap_cr > 1000
          )
          SELECT sector,
                 AVG(return_pct) AS avg_return,
                 COUNT(*) AS company_count,
                 MIN(return_pct) AS min_return,
                 MAX(return_pct) AS max_return
          FROM sector_returns
          WHERE return_pct IS NOT NULL
          GROUP BY sector
          ORDER BY avg_return DESC`,
          [days]
        );

        if (rows.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_sector_rotation',
                `No sector return data available for period ${period}.`,
                'Ensure price data is available for the requested lookback period.'
              ),
            }],
          };
        }

        const sectors = rows.map((r: Record<string, unknown>) => {
          const avgReturn = roundTo(toNum(r.avg_return), 2);
          let signal: string;
          if (avgReturn > inflowThreshold) signal = 'inflow';
          else if (avgReturn < outflowThreshold) signal = 'outflow';
          else signal = 'neutral';

          return {
            sector: r.sector,
            avgReturnPct: avgReturn,
            companyCount: toNum(r.company_count),
            minReturnPct: roundTo(toNum(r.min_return), 2),
            maxReturnPct: roundTo(toNum(r.max_return), 2),
            signal,
          };
        });

        const inflowSectors = sectors.filter(s => s.signal === 'inflow').length;
        const outflowSectors = sectors.filter(s => s.signal === 'outflow').length;

        const result = {
          period,
          days,
          sectorsAnalyzed: sectors.length,
          inflowSectors,
          outflowSectors,
          sectors,
        };

        await cacheSet(key, result, 900); // 15 min TTL

        const topSector = sectors[0];
        const bottomSector = sectors[sectors.length - 1];

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Sector rotation (${period}): ${sectors.length} sectors. Top: ${topSector.sector} (${topSector.avgReturnPct >= 0 ? '+' : ''}${topSector.avgReturnPct}%). Bottom: ${bottomSector.sector} (${bottomSector.avgReturnPct >= 0 ? '+' : ''}${bottomSector.avgReturnPct}%). ${inflowSectors} inflow, ${outflowSectors} outflow.`,
              data: result,
              context: {
                units: { returns: 'Percentage (%)' },
                note: `Only companies with market cap > 1000 Cr included to reduce noise. Signal thresholds for ${period}: inflow > ${inflowThreshold}%, outflow < ${outflowThreshold}%.`,
              },
              relatedTools: ['get_market_overview', 'get_sector_overview', 'run_screen'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_sector_rotation',
              err instanceof Error ? err.message : 'Sector rotation analysis failed'
            ),
          }],
        };
      }
    }
  );
}
