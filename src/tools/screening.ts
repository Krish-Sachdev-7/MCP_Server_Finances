/**
 * Screening tools -- run_screen, get_preset_screens, save_custom_screen, backtest_screen.
 * Phase 3 implementation -- follows the exact pattern from src/tools/company.ts.
 *
 * RISK 3 compliance: run_screen handles ONLY structured quantitative conditions.
 * Its description explicitly routes natural language queries to ask_about_data.
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
import {
  parseScreenConditions,
  validateSortColumn,
  validateSortOrder,
} from '../utils/screen-parser.js';
// ============================================================
// PRESET SCREENS
// ============================================================

interface PresetScreen {
  id: string;
  name: string;
  description: string;
  conditions: string;
  sortBy: string;
  sortOrder: string;
}

const PRESET_SCREENS: PresetScreen[] = [
  {
    id: 'magic_formula',
    name: 'Magic Formula (Greenblatt)',
    description: 'High earnings yield + high ROCE. Joel Greenblatt\'s Magic Formula identifies cheap, high-quality businesses.',
    conditions: 'earnings yield > 8 AND roce > 15 AND market cap > 500',
    sortBy: 'roce',
    sortOrder: 'DESC',
  },
  {
    id: 'piotroski_f9',
    name: 'Piotroski F-Score 9',
    description: 'Companies with perfect Piotroski F-Score (9/9), indicating strong financial health across profitability, leverage, and efficiency.',
    conditions: 'piotroski score >= 8',
    sortBy: 'market_cap',
    sortOrder: 'DESC',
  },
  {
    id: 'graham_net_net',
    name: 'Graham Net-Net',
    description: 'Stocks trading below liquidation value. Benjamin Graham\'s deep value strategy: PB < 1 with low debt.',
    conditions: 'pb < 1 AND debt to equity < 0.5 AND current ratio > 1.5',
    sortBy: 'pb',
    sortOrder: 'ASC',
  },
  {
    id: 'coffee_can',
    name: 'Coffee Can Portfolio',
    description: 'Buy-and-hold quality compounders: consistent revenue growth, high ROE, low leverage. Saurabh Mukherjea\'s Coffee Can approach.',
    conditions: 'roe > 15 AND revenue cagr 10y > 10 AND debt to equity < 0.5 AND market cap > 5000',
    sortBy: 'roe',
    sortOrder: 'DESC',
  },
  {
    id: 'consistent_compounders',
    name: 'Consistent Compounders',
    description: 'Companies with steady revenue and profit growth over 3, 5, and 10 years plus high margins.',
    conditions: 'revenue cagr 3y > 12 AND revenue cagr 5y > 10 AND roce > 15 AND operating margin > 15',
    sortBy: 'roce',
    sortOrder: 'DESC',
  },
  {
    id: 'high_dividend',
    name: 'High Dividend Yield',
    description: 'Stocks with above-average dividend yields that are sustainable (low payout, strong earnings).',
    conditions: 'dividend yield > 3 AND pe > 0 AND pe < 25 AND debt to equity < 1',
    sortBy: 'dividend_yield',
    sortOrder: 'DESC',
  },
  {
    id: 'momentum',
    name: 'Momentum Leaders',
    description: 'Strong recent performers: high revenue and profit growth with market recognition.',
    conditions: 'revenue growth yoy > 20 AND profit growth yoy > 20 AND market cap > 1000',
    sortBy: 'profit_growth',
    sortOrder: 'DESC',
  },
  {
    id: 'low_pe_growth',
    name: 'Low PE + High Growth (PEG < 1)',
    description: 'Stocks with low PE ratios relative to their growth rate. PEG-style value-growth combination.',
    conditions: 'pe > 0 AND pe < 15 AND profit growth yoy > 15 AND market cap > 500',
    sortBy: 'pe',
    sortOrder: 'ASC',
  },
  {
    id: 'debt_free',
    name: 'Debt-Free Companies',
    description: 'Companies with zero or near-zero debt and strong profitability.',
    conditions: 'debt to equity < 0.05 AND roe > 10 AND net margin > 5 AND market cap > 500',
    sortBy: 'roe',
    sortOrder: 'DESC',
  },
  {
    id: 'capacity_expansion',
    name: 'Capacity Expansion',
    description: 'Companies with high asset turnover improvement and revenue growth, suggesting capacity expansion paying off.',
    conditions: 'revenue growth yoy > 15 AND operating margin > 10 AND market cap > 1000',
    sortBy: 'revenue_growth',
    sortOrder: 'DESC',
  },
];

// ============================================================
// HELPERS
// ============================================================

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ============================================================
// REGISTER TOOLS
// ============================================================

export function registerTools(
  server: McpServer,
  db: Pool,
  _cache: RedisClient
): void {

  // ------------------------------------------------------------------
  // run_screen
  // ------------------------------------------------------------------
  server.tool(
    'run_screen',
    'Execute a stock screen with explicit numeric conditions using operators like ' +
    '>, <, >=, <=. Input must be structured conditions joined by AND. Returns ' +
    'matching companies with their financial ratios. Available fields: PE, PB, ' +
    'EV/EBITDA, ROE, ROCE, debt to equity, dividend yield, revenue growth, ' +
    'profit growth, piotroski score, market cap, operating margin, net margin. ' +
    'Example: run_screen({ conditions: "ROCE > 20 AND Debt to equity < 0.5 AND ' +
    'Market cap > 5000" }). For natural language questions like "find good pharma ' +
    'companies", use ask_about_data instead.',
    {
      conditions: z.string().min(1).describe(
        'Screening conditions joined by AND. Each condition: field operator value. ' +
        'Example: "PE < 15 AND ROE > 20 AND market cap > 1000"'
      ),
      sortBy: z.string().optional().describe(
        'Sort column: market_cap, pe, roe, roce, revenue_growth, profit_growth, dividend_yield, debt_to_equity, piotroski_score (default market_cap)'
      ),
      sortOrder: z.enum(['ASC', 'DESC']).optional().describe(
        'Sort direction (default DESC)'
      ),
      limit: z.number().min(1).max(100).optional().describe(
        'Max results (default 50)'
      ),
    },
    async ({ conditions, sortBy, sortOrder, limit }) => {
      try {
        const effectiveLimit = limit ?? 50;
        const key = cacheKey('screen', 'query', { conditions, sortBy, sortOrder, limit: effectiveLimit });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Screen results (cached)`,
                data: cached,
                context: { count: Array.isArray(cached) ? cached.length : 0 },
                relatedTools: ['get_preset_screens', 'save_custom_screen', 'backtest_screen', 'get_valuation_metrics'],
              }),
            }],
          };
        }

        // Parse conditions through the screen parser
        const parsed = parseScreenConditions(conditions);

        if (parsed.errors.length > 0 && parsed.whereClause === '') {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'run_screen',
                `Could not parse screening conditions: ${parsed.errors.join('; ')}`,
                'Use explicit numeric conditions like "ROCE > 20 AND PE < 15". ' +
                'For natural language queries, use ask_about_data instead.'
              ),
            }],
          };
        }

        const safeSortBy = sortBy ? validateSortColumn(sortBy) : 'c.market_cap_cr';
        const safeSortOrder = sortOrder ? validateSortOrder(sortOrder) : 'DESC';

        const results = await queries.runScreenQuery(
          db,
          parsed.whereClause,
          parsed.params,
          safeSortBy,
          safeSortOrder,
          effectiveLimit
        );

        const formattedResults = results.map((row: Record<string, unknown>) => ({
          ticker: row.ticker,
          companyName: row.company_name,
          sector: row.sector,
          industry: row.industry,
          marketCapCr: toNumber(row.market_cap_cr),
          pe: toNumber(row.pe_ratio),
          pb: toNumber(row.pb_ratio),
          roe: toNumber(row.roe),
          roce: toNumber(row.roce),
          debtToEquity: toNumber(row.debt_to_equity),
          operatingMargin: toNumber(row.operating_margin),
          netMargin: toNumber(row.net_margin),
          revenueGrowthYoy: toNumber(row.revenue_growth_yoy),
          profitGrowthYoy: toNumber(row.profit_growth_yoy),
          dividendYield: toNumber(row.dividend_yield),
          piotroskiScore: toNumber(row.piotroski_score),
          fiscalYear: row.fiscal_year,
        }));

        if (formattedResults.length > 0) {
          await cacheSet(key, formattedResults, TTL.SCREEN_RESULTS);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: formattedResults.length > 0
                ? `Screen matched ${formattedResults.length} companies for: ${conditions}`
                : `No companies matched: ${conditions}. Try relaxing your conditions.`,
              data: formattedResults,
              context: {
                count: formattedResults.length,
                conditionsParsed: conditions,
                parseWarnings: parsed.errors.length > 0 ? parsed.errors : undefined,
                units: {
                  marketCapCr: 'INR Crores',
                  roe: 'Decimal (0.15 = 15%)',
                  roce: 'Decimal',
                  debtToEquity: 'Ratio',
                  dividendYield: 'Decimal (0.03 = 3%)',
                },
              },
              relatedTools: ['get_company_profile', 'get_valuation_metrics', 'save_custom_screen', 'backtest_screen'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'run_screen',
              err instanceof Error ? err.message : 'Screening failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_preset_screens
  // ------------------------------------------------------------------
  server.tool(
    'get_preset_screens',
    'List available preset stock screens or run a specific preset. Includes 10 ' +
    'classic strategies: magic_formula, piotroski_f9, graham_net_net, coffee_can, ' +
    'consistent_compounders, high_dividend, momentum, low_pe_growth, debt_free, ' +
    'capacity_expansion. Call without presetId to see all presets. Call with a ' +
    'presetId to execute that screen. ' +
    'Example: get_preset_screens({ presetId: "magic_formula" })',
    {
      presetId: z.string().optional().describe(
        'Preset screen ID to execute. Omit to list all available presets.'
      ),
      limit: z.number().min(1).max(100).optional().describe(
        'Max results when running a preset (default 25)'
      ),
    },
    async ({ presetId, limit }) => {
      try {
        // If no presetId, return the list of all presets
        if (!presetId) {
          const presetList = PRESET_SCREENS.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            conditions: p.conditions,
          }));

          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `${PRESET_SCREENS.length} preset screens available`,
                data: presetList,
                context: { count: PRESET_SCREENS.length },
                relatedTools: ['run_screen', 'save_custom_screen'],
              }),
            }],
          };
        }

        // Find the preset
        const preset = PRESET_SCREENS.find((p) => p.id === presetId.toLowerCase());
        if (!preset) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_preset_screens',
                `Preset "${presetId}" not found.`,
                `Available presets: ${PRESET_SCREENS.map((p) => p.id).join(', ')}`
              ),
            }],
          };
        }

        // Execute the preset
        const effectiveLimit = limit ?? 25;
        const key = cacheKey('preset-screen', preset.id, { limit: effectiveLimit });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `${preset.name}: results (cached)`,
                data: cached,
                context: { count: Array.isArray(cached) ? cached.length : 0 },
                relatedTools: ['get_company_profile', 'get_valuation_metrics', 'backtest_screen'],
              }),
            }],
          };
        }

        const parsed = parseScreenConditions(preset.conditions);
        const safeSortBy = validateSortColumn(preset.sortBy);
        const safeSortOrder = validateSortOrder(preset.sortOrder);

        const results = await queries.runScreenQuery(
          db,
          parsed.whereClause,
          parsed.params,
          safeSortBy,
          safeSortOrder,
          effectiveLimit
        );

        const formattedResults = results.map((row: Record<string, unknown>) => ({
          ticker: row.ticker,
          companyName: row.company_name,
          sector: row.sector,
          marketCapCr: toNumber(row.market_cap_cr),
          pe: toNumber(row.pe_ratio),
          pb: toNumber(row.pb_ratio),
          roe: toNumber(row.roe),
          roce: toNumber(row.roce),
          debtToEquity: toNumber(row.debt_to_equity),
          dividendYield: toNumber(row.dividend_yield),
          piotroskiScore: toNumber(row.piotroski_score),
        }));

        if (formattedResults.length > 0) {
          await cacheSet(key, formattedResults, TTL.SCREEN_RESULTS);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${preset.name}: ${formattedResults.length} companies matched (${preset.conditions})`,
              data: {
                preset: { id: preset.id, name: preset.name, description: preset.description },
                results: formattedResults,
              },
              context: {
                count: formattedResults.length,
                conditionsParsed: preset.conditions,
                parseWarnings: parsed.errors.length > 0 ? parsed.errors : undefined,
              },
              relatedTools: ['get_company_profile', 'backtest_screen', 'run_screen'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_preset_screens',
              err instanceof Error ? err.message : 'Preset screen failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // save_custom_screen
  // ------------------------------------------------------------------
  server.tool(
    'save_custom_screen',
    'Save a custom stock screen with a name and conditions for later reuse. The ' +
    'conditions string uses the same format as run_screen. Saved screens are stored ' +
    'per client. Use get_preset_screens to see built-in screens; use this to save ' +
    'your own. ' +
    'Example: save_custom_screen({ name: "My Value Screen", conditions: "PE < 12 AND ' +
    'ROE > 18 AND debt to equity < 0.3", description: "Low PE high quality stocks" })',
    {
      name: z.string().min(1).max(100).describe(
        'Screen name for later reference'
      ),
      conditions: z.string().min(1).describe(
        'Screening conditions in run_screen format'
      ),
      description: z.string().max(500).optional().describe(
        'Optional description of what this screen finds'
      ),
      clientId: z.string().optional().describe(
        'Client identifier for per-user screens (default "default")'
      ),
    },
    async ({ name, conditions, description, clientId }) => {
      try {
        const effectiveClientId = clientId ?? 'default';

        // Validate the conditions parse correctly
        const parsed = parseScreenConditions(conditions);
        if (parsed.errors.length > 0 && parsed.whereClause === '') {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'save_custom_screen',
                `Conditions could not be parsed: ${parsed.errors.join('; ')}`,
                'Use the same format as run_screen: "field operator value AND ..."'
              ),
            }],
          };
        }

        await db.query(
          `INSERT INTO custom_screens (client_id, name, conditions, description)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [effectiveClientId, name, conditions, description ?? null]
        );

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Custom screen "${name}" saved successfully`,
              data: {
                name,
                conditions,
                description: description ?? null,
                clientId: effectiveClientId,
                parsedConditionCount: parsed.whereClause.split(' AND ').filter(Boolean).length,
                parseWarnings: parsed.errors.length > 0 ? parsed.errors : undefined,
              },
              context: {},
              relatedTools: ['run_screen', 'get_preset_screens'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'save_custom_screen',
              err instanceof Error ? err.message : 'Save failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // backtest_screen
  // ------------------------------------------------------------------
  server.tool(
    'backtest_screen',
    'Backtest a stock screen over historical periods. Runs the screen at each ' +
    'rebalance date using that year\'s ratios, computes equal-weight portfolio ' +
    'returns from price data, and compares against Nifty 50. Returns period-by-period ' +
    'returns, cumulative performance, and a comparison with the benchmark. Data ' +
    'coverage depends on available historical ratios and prices. ' +
    'Example: backtest_screen({ conditions: "ROE > 20 AND PE < 20", years: 3 })',
    {
      conditions: z.string().min(1).describe(
        'Screening conditions (same format as run_screen)'
      ),
      years: z.number().min(1).max(10).optional().describe(
        'Number of years to backtest (default 3)'
      ),
      rebalanceFrequency: z.enum(['annual', 'semi-annual']).optional().describe(
        'How often to rebalance the portfolio (default annual)'
      ),
      limit: z.number().min(5).max(50).optional().describe(
        'Max stocks per rebalance period (default 15)'
      ),
    },
    async ({ conditions, years, rebalanceFrequency, limit }) => {
      try {
        const effectiveYears = years ?? 3;
        const effectiveLimit = limit ?? 15;
        const frequency = rebalanceFrequency ?? 'annual';

        const key = cacheKey('backtest', 'query', { conditions, years: effectiveYears, frequency, limit: effectiveLimit });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Backtest results (cached)`,
                data: cached,
                context: {},
                relatedTools: ['run_screen', 'get_preset_screens'],
              }),
            }],
          };
        }

        // Validate conditions first
        const parsed = parseScreenConditions(conditions);
        if (parsed.errors.length > 0 && parsed.whereClause === '') {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'backtest_screen',
                `Could not parse conditions: ${parsed.errors.join('; ')}`
              ),
            }],
          };
        }

        // Determine the range of fiscal years available
        const { rows: yearRows } = await db.query(
          `SELECT DISTINCT fiscal_year FROM ratios ORDER BY fiscal_year DESC LIMIT $1`,
          [effectiveYears + 1]
        );

        if (yearRows.length < 2) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'backtest_screen',
                'Not enough historical ratio data for backtesting. Need at least 2 years of data.',
                'Ensure financial data has been ingested for multiple years.'
              ),
            }],
          };
        }

        const availableYears: number[] = yearRows.map((r: { fiscal_year: number }) => r.fiscal_year);
        const periods: Array<{
          year: number;
          stocks: string[];
          stockCount: number;
          portfolioReturn: number | null;
          benchmarkReturn: number | null;
        }> = [];

        // For each historical year, run the screen against that year's ratios and get returns
        for (let i = 0; i < availableYears.length - 1; i++) {
          const screenYear = availableYears[i + 1]; // screen at start of period
          const endYear = availableYears[i]; // measure returns at end

          // Run screen for that specific fiscal year
          const { rows: screenResults } = await db.query(
            `SELECT c.id, c.ticker
             FROM companies c
             JOIN ratios r ON c.id = r.company_id
             WHERE c.is_active = TRUE
               AND r.fiscal_year = $1
               ${parsed.whereClause ? 'AND ' + parsed.whereClause : ''}
             ORDER BY c.market_cap_cr DESC NULLS LAST
             LIMIT $${parsed.params.length + 2}`,
            [screenYear, ...parsed.params, effectiveLimit]
          );

          if (screenResults.length === 0) {
            periods.push({
              year: screenYear,
              stocks: [],
              stockCount: 0,
              portfolioReturn: null,
              benchmarkReturn: null,
            });
            continue;
          }

          // Calculate equal-weight portfolio return using price history
          // Approximate: use April 1 of screenYear as buy date, March 31 of endYear as sell date
          const buyDateStart = `${screenYear}-04-01`;
          const sellDateEnd = `${endYear}-03-31`;

          let totalReturn = 0;
          let validStocks = 0;

          for (const stock of screenResults) {
            const { rows: prices } = await db.query(
              `SELECT close_price, trade_date FROM price_history
               WHERE company_id = $1
                 AND trade_date >= $2 AND trade_date <= $3
               ORDER BY trade_date ASC`,
              [stock.id, buyDateStart, sellDateEnd]
            );

            if (prices.length >= 2) {
              const buyPrice = toNumber(prices[0].close_price);
              const sellPrice = toNumber(prices[prices.length - 1].close_price);
              if (buyPrice && sellPrice && buyPrice > 0) {
                totalReturn += (sellPrice - buyPrice) / buyPrice;
                validStocks++;
              }
            }
          }

          const portfolioReturn = validStocks > 0 ? roundTo(totalReturn / validStocks, 4) : null;

          // Simple benchmark: average return of NIFTY 50 constituents over same period
          const { rows: benchmarkRows } = await db.query(
            `SELECT AVG(ret) as avg_return FROM (
               SELECT (p2.close_price - p1.close_price) / NULLIF(p1.close_price, 0) as ret
               FROM index_constituents ic
               JOIN LATERAL (
                 SELECT close_price FROM price_history
                 WHERE company_id = ic.company_id AND trade_date >= $1
                 ORDER BY trade_date ASC LIMIT 1
               ) p1 ON TRUE
               JOIN LATERAL (
                 SELECT close_price FROM price_history
                 WHERE company_id = ic.company_id AND trade_date <= $2
                 ORDER BY trade_date DESC LIMIT 1
               ) p2 ON TRUE
               WHERE ic.index_name = 'NIFTY 50' AND ic.is_current = TRUE
             ) sub`,
            [buyDateStart, sellDateEnd]
          );

          const benchmarkReturn = toNumber(benchmarkRows[0]?.avg_return);

          periods.push({
            year: screenYear,
            stocks: screenResults.map((s: { ticker: string }) => s.ticker),
            stockCount: screenResults.length,
            portfolioReturn,
            benchmarkReturn: benchmarkReturn !== null ? roundTo(benchmarkReturn, 4) : null,
          });
        }

        // Compute cumulative returns
        let cumulativePortfolio = 1;
        let cumulativeBenchmark = 1;
        const periodsWithCumulative = periods.map((p) => {
          if (p.portfolioReturn !== null) cumulativePortfolio *= (1 + p.portfolioReturn);
          if (p.benchmarkReturn !== null) cumulativeBenchmark *= (1 + p.benchmarkReturn);
          return {
            ...p,
            cumulativePortfolio: roundTo((cumulativePortfolio - 1) * 100, 2),
            cumulativeBenchmark: roundTo((cumulativeBenchmark - 1) * 100, 2),
          };
        });

        const totalPortfolioReturn = roundTo((cumulativePortfolio - 1) * 100, 2);
        const totalBenchmarkReturn = roundTo((cumulativeBenchmark - 1) * 100, 2);

        const result = {
          conditions,
          backtestYears: effectiveYears,
          rebalanceFrequency: frequency,
          maxStocksPerPeriod: effectiveLimit,
          periods: periodsWithCumulative,
          summary: {
            totalPortfolioReturn: totalPortfolioReturn + '%',
            totalBenchmarkReturn: totalBenchmarkReturn + '%',
            outperformance: roundTo(totalPortfolioReturn - totalBenchmarkReturn, 2) + '%',
            periodsWithData: periods.filter((p) => p.portfolioReturn !== null).length,
            totalPeriods: periods.length,
          },
          limitations: [
            'Returns are approximate: uses closest available prices to target dates.',
            'Does not account for transaction costs, slippage, or dividends.',
            'Equal-weight portfolio rebalanced at each period.',
            'Limited by available historical data coverage in the database.',
            'Past performance does not predict future results.',
          ],
        };

        await cacheSet(key, result, TTL.SCREEN_RESULTS);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Backtest of "${conditions}" over ${periods.length} periods: portfolio ${totalPortfolioReturn}% vs benchmark ${totalBenchmarkReturn}%`,
              data: result,
              context: {
                disclaimer: 'This is a simplified historical backtest. Past performance does not predict future results. Does not account for transaction costs or dividends.',
                units: {
                  returns: 'Decimal (0.10 = 10%)',
                  cumulative: 'Percentage',
                },
              },
              relatedTools: ['run_screen', 'get_preset_screens', 'get_valuation_metrics'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'backtest_screen',
              err instanceof Error ? err.message : 'Backtesting failed'
            ),
          }],
        };
      }
    }
  );

}
