/**
 * Financial statement tools — P&L, balance sheet, cash flow, ratios, quarterly results, compare.
 * Phase 3 implementation — follow the pattern in src/tools/company.ts exactly.
 *
 * Tools to implement:
 * - get_income_statement
 * - get_balance_sheet
 * - get_cash_flow
 * - get_financial_ratios
 * - get_quarterly_results
 * - compare_financials
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from '../db/connection.js';
import type { RedisClient } from '../cache/redis.js';
import * as queries from '../db/queries.js';
import { cacheGet, cacheKey, cacheSet, TTL } from '../cache/redis.js';
import {
  buildErrorResponse,
  buildResponse,
  normalizeTicker,
} from '../utils/response-builder.js';

export function registerTools(
  server: McpServer,
  db: Pool,
  _cache: RedisClient
): void {
  server.tool(
    'get_income_statement',
    'Get a company income statement time series and returns period-wise revenue, expenses, operating profit, other income, profit before tax, tax, net profit, EPS, and YoY growth. Use this when analyzing earnings trends over time. For balance sheet structure use get_balance_sheet; for cash generation use get_cash_flow. Example: get_income_statement({ ticker: "RELIANCE", period: "annual", years: 5 })',
    {
      ticker: z.string().min(1).describe('Company ticker, e.g. RELIANCE, TCS, HDFCBANK'),
      period: z.enum(['annual', 'quarterly']).describe('Statement periodicity: annual or quarterly'),
      years: z.number().min(1).max(15).optional().describe('Years to return (default 5; quarterly returns years*4 periods)'),
    },
    async ({ ticker, period, years }) => {
      try {
        const normalizedTicker = normalizeTicker(ticker);
        const effectiveYears = years || 5;
        const key = cacheKey('fin-income', normalizedTicker, { period, years: effectiveYears });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Income statement for ${normalizedTicker} (${period}, cached)`,
                data: cached,
                context: { ticker: normalizedTicker, period, count: Array.isArray(cached) ? cached.length : undefined },
                relatedTools: ['get_balance_sheet', 'get_cash_flow', 'get_financial_ratios', 'compare_financials'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalizedTicker);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('get_income_statement', `Company "${normalizedTicker}" not found.`, 'Use search_companies to find the correct ticker.'),
            }],
          };
        }

        const rawRows = period === 'annual'
          ? await queries.getAnnualFinancials(db, company.id, effectiveYears)
          : await queries.getQuarterlyFinancials(db, company.id, effectiveYears * 4);

        const growthOffset = period === 'annual' ? 1 : 4;
        const statement = rawRows.map((row, rowIndex) => {
          const previousRow = rawRows[rowIndex + growthOffset];
          const revenue = toNumber(row.revenue);
          const netProfit = toNumber(row.net_profit);
          const eps = toNumber(row.eps);

          return {
            fiscalYear: row.fiscal_year,
            quarter: row.quarter ?? null,
            periodEndDate: row.period_end_date,
            revenue,
            expenses: toNumber(row.expenses),
            operatingProfit: toNumber(row.operating_profit),
            otherIncome: toNumber(row.other_income),
            pbt: toNumber(row.profit_before_tax),
            tax: toNumber(row.tax_expense),
            netProfit,
            eps,
            yoyGrowthPct: {
              revenue: pctChange(revenue, toNumber(previousRow?.revenue)),
              netProfit: pctChange(netProfit, toNumber(previousRow?.net_profit)),
              eps: pctChange(eps, toNumber(previousRow?.eps)),
            },
          };
        });

        if (statement.length > 0) {
          await cacheSet(key, statement, TTL.FINANCIAL_DATA);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: statement.length > 0
                ? `${company.company_name} (${normalizedTicker}) income statement: ${statement.length} ${period} periods`
                : `No ${period} income statement data found for ${normalizedTicker}`,
              data: statement,
              context: {
                ticker: normalizedTicker,
                period,
                count: statement.length,
                units: {
                  revenue: 'INR Crores',
                  expenses: 'INR Crores',
                  operatingProfit: 'INR Crores',
                  netProfit: 'INR Crores',
                  eps: 'INR',
                  yoyGrowthPct: 'Percentage',
                },
              },
              relatedTools: ['get_balance_sheet', 'get_cash_flow', 'get_financial_ratios', 'compare_financials'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_income_statement',
              err instanceof Error ? err.message : 'Income statement fetch failed'
            ),
          }],
        };
      }
    }
  );

  server.tool(
    'get_balance_sheet',
    'Get a company balance sheet time series and returns equity, reserves, borrowings, liabilities, fixed assets, investments, other assets, and total assets by period. Use this for capital structure and asset quality analysis. For earnings use get_income_statement; for cash generation use get_cash_flow. Example: get_balance_sheet({ ticker: "TCS", period: "annual", years: 5 })',
    {
      ticker: z.string().min(1).describe('Company ticker, e.g. TCS, INFY, ICICIBANK'),
      period: z.enum(['annual', 'quarterly']).describe('Statement periodicity: annual or quarterly'),
      years: z.number().min(1).max(15).optional().describe('Years to return (default 5; quarterly returns years*4 periods)'),
    },
    async ({ ticker, period, years }) => {
      try {
        const normalizedTicker = normalizeTicker(ticker);
        const effectiveYears = years || 5;
        const key = cacheKey('fin-balance-sheet', normalizedTicker, { period, years: effectiveYears });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Balance sheet for ${normalizedTicker} (${period}, cached)`,
                data: cached,
                context: { ticker: normalizedTicker, period, count: Array.isArray(cached) ? cached.length : undefined },
                relatedTools: ['get_income_statement', 'get_cash_flow', 'get_financial_ratios', 'compare_financials'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalizedTicker);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('get_balance_sheet', `Company "${normalizedTicker}" not found.`, 'Use search_companies to find the correct ticker.'),
            }],
          };
        }

        const rawRows = period === 'annual'
          ? await queries.getAnnualFinancials(db, company.id, effectiveYears)
          : await queries.getQuarterlyFinancials(db, company.id, effectiveYears * 4);

        const statement = rawRows.map((row) => ({
          fiscalYear: row.fiscal_year,
          quarter: row.quarter ?? null,
          periodEndDate: row.period_end_date,
          equity: toNumber(row.equity_capital),
          reserves: toNumber(row.reserves),
          borrowings: toNumber(row.total_borrowings),
          otherLiabilities: toNumber(row.other_liabilities),
          fixedAssets: toNumber(row.fixed_assets),
          investments: toNumber(row.investments),
          otherAssets: toNumber(row.other_assets),
          totalAssets: toNumber(row.total_assets),
        }));

        if (statement.length > 0) {
          await cacheSet(key, statement, TTL.FINANCIAL_DATA);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: statement.length > 0
                ? `${company.company_name} (${normalizedTicker}) balance sheet: ${statement.length} ${period} periods`
                : `No ${period} balance sheet data found for ${normalizedTicker}`,
              data: statement,
              context: {
                ticker: normalizedTicker,
                period,
                count: statement.length,
                units: {
                  equity: 'INR Crores',
                  reserves: 'INR Crores',
                  borrowings: 'INR Crores',
                  totalAssets: 'INR Crores',
                },
              },
              relatedTools: ['get_income_statement', 'get_cash_flow', 'get_financial_ratios', 'compare_financials'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_balance_sheet',
              err instanceof Error ? err.message : 'Balance sheet fetch failed'
            ),
          }],
        };
      }
    }
  );

  server.tool(
    'get_cash_flow',
    'Get a company cash flow statement time series and returns operating, investing, financing, net cash flow, capex, and computed free cash flow (OCF - capex). Use this for cash generation and reinvestment analysis. For profitability trends use get_income_statement. Example: get_cash_flow({ ticker: "HDFCBANK", period: "annual", years: 5 })',
    {
      ticker: z.string().min(1).describe('Company ticker, e.g. HDFCBANK, KOTAKBANK'),
      period: z.enum(['annual', 'quarterly']).describe('Statement periodicity: annual or quarterly'),
      years: z.number().min(1).max(15).optional().describe('Years to return (default 5; quarterly returns years*4 periods)'),
    },
    async ({ ticker, period, years }) => {
      try {
        const normalizedTicker = normalizeTicker(ticker);
        const effectiveYears = years || 5;
        const key = cacheKey('fin-cash-flow', normalizedTicker, { period, years: effectiveYears });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Cash flow for ${normalizedTicker} (${period}, cached)`,
                data: cached,
                context: { ticker: normalizedTicker, period, count: Array.isArray(cached) ? cached.length : undefined },
                relatedTools: ['get_income_statement', 'get_balance_sheet', 'get_financial_ratios', 'compare_financials'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalizedTicker);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('get_cash_flow', `Company "${normalizedTicker}" not found.`, 'Use search_companies to find the correct ticker.'),
            }],
          };
        }

        const rawRows = period === 'annual'
          ? await queries.getAnnualFinancials(db, company.id, effectiveYears)
          : await queries.getQuarterlyFinancials(db, company.id, effectiveYears * 4);

        const statement = rawRows.map((row) => {
          const operatingCashFlow = toNumber(row.operating_cash_flow);
          const capex = toNumber(row.capex);

          return {
            fiscalYear: row.fiscal_year,
            quarter: row.quarter ?? null,
            periodEndDate: row.period_end_date,
            operatingCashFlow,
            investingCashFlow: toNumber(row.investing_cash_flow),
            financingCashFlow: toNumber(row.financing_cash_flow),
            netCashFlow: toNumber(row.net_cash_flow),
            capex,
            freeCashFlow: operatingCashFlow !== null && capex !== null ? roundTo(operatingCashFlow - capex, 2) : null,
          };
        });

        if (statement.length > 0) {
          await cacheSet(key, statement, TTL.FINANCIAL_DATA);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: statement.length > 0
                ? `${company.company_name} (${normalizedTicker}) cash flow: ${statement.length} ${period} periods`
                : `No ${period} cash flow data found for ${normalizedTicker}`,
              data: statement,
              context: {
                ticker: normalizedTicker,
                period,
                count: statement.length,
                units: {
                  operatingCashFlow: 'INR Crores',
                  investingCashFlow: 'INR Crores',
                  financingCashFlow: 'INR Crores',
                  freeCashFlow: 'INR Crores',
                },
              },
              relatedTools: ['get_income_statement', 'get_balance_sheet', 'get_financial_ratios', 'compare_financials'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_cash_flow',
              err instanceof Error ? err.message : 'Cash flow fetch failed'
            ),
          }],
        };
      }
    }
  );

  server.tool(
    'get_financial_ratios',
    'Get historical financial ratios for a company and returns valuation, profitability, leverage, and efficiency metrics across years. Use this when the user asks about ROE/ROCE trends, valuation history, or quality metrics. For raw statements use get_income_statement or get_balance_sheet. Example: get_financial_ratios({ ticker: "INFY", years: 10 })',
    {
      ticker: z.string().min(1).describe('Company ticker, e.g. INFY, LT, MARUTI'),
      years: z.number().min(1).max(15).optional().describe('Years of ratio history (default 10)'),
    },
    async ({ ticker, years }) => {
      try {
        const normalizedTicker = normalizeTicker(ticker);
        const effectiveYears = years || 10;
        const key = cacheKey('fin-ratios', normalizedTicker, { years: effectiveYears });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Financial ratios for ${normalizedTicker} (cached)`,
                data: cached,
                context: { ticker: normalizedTicker, period: 'annual', count: Array.isArray(cached) ? cached.length : undefined },
                relatedTools: ['get_income_statement', 'get_balance_sheet', 'compare_financials', 'run_screen'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalizedTicker);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('get_financial_ratios', `Company "${normalizedTicker}" not found.`, 'Use search_companies to find the correct ticker.'),
            }],
          };
        }

        const ratioRows = await queries.getRatios(db, company.id, effectiveYears);
        const ratios = ratioRows.map((row) => ({
          fiscalYear: row.fiscal_year,
          pe: toNumber(row.pe_ratio),
          pb: toNumber(row.pb_ratio),
          roe: toNumber(row.roe),
          roce: toNumber(row.roce),
          debtToEquity: toNumber(row.debt_to_equity),
          currentRatio: toNumber(row.current_ratio),
          dividendYield: toNumber(row.dividend_yield),
          operatingMargin: toNumber(row.operating_margin),
          netMargin: toNumber(row.net_margin),
          assetTurnover: toNumber(row.asset_turnover),
          interestCoverage: toNumber(row.interest_coverage),
          earningsYield: toNumber(row.earnings_yield),
          fcfYield: toNumber(row.fcf_yield),
          piotroskiScore: toNumber(row.piotroski_score),
        }));

        if (ratios.length > 0) {
          await cacheSet(key, ratios, TTL.FINANCIAL_DATA);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: ratios.length > 0
                ? `${company.company_name} (${normalizedTicker}) ratios for ${ratios.length} years`
                : `No ratio data found for ${normalizedTicker}`,
              data: ratios,
              context: {
                ticker: normalizedTicker,
                period: 'annual',
                count: ratios.length,
                units: {
                  pe: 'x',
                  pb: 'x',
                  roe: 'Decimal (0.15 = 15%)',
                  roce: 'Decimal (0.15 = 15%)',
                  dividendYield: 'Decimal (0.03 = 3%)',
                },
              },
              relatedTools: ['get_income_statement', 'get_balance_sheet', 'compare_financials', 'run_screen'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_financial_ratios',
              err instanceof Error ? err.message : 'Financial ratios fetch failed'
            ),
          }],
        };
      }
    }
  );

  server.tool(
    'get_quarterly_results',
    'Get latest quarterly results and returns revenue, profit, operating margin, YoY growth, QoQ growth, and flags for significant changes. Use this for recent performance trend checks around earnings seasons. For long annual history use get_income_statement with period annual. Example: get_quarterly_results({ ticker: "ITC", quarters: 8 })',
    {
      ticker: z.string().min(1).describe('Company ticker, e.g. ITC, ASIANPAINT, BAJFINANCE'),
      quarters: z.number().min(4).max(20).optional().describe('Number of latest quarters to return (default 8)'),
    },
    async ({ ticker, quarters }) => {
      try {
        const normalizedTicker = normalizeTicker(ticker);
        const effectiveQuarters = quarters || 8;
        const key = cacheKey('fin-quarterly-results', normalizedTicker, { quarters: effectiveQuarters });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Quarterly results for ${normalizedTicker} (cached)`,
                data: cached,
                context: { ticker: normalizedTicker, period: 'quarterly', count: Array.isArray(cached) ? cached.length : undefined },
                relatedTools: ['get_income_statement', 'get_financial_ratios', 'compare_financials', 'get_company_profile'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalizedTicker);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('get_quarterly_results', `Company "${normalizedTicker}" not found.`, 'Use search_companies to find the correct ticker.'),
            }],
          };
        }

        const rawRows = await queries.getQuarterlyFinancials(db, company.id, effectiveQuarters + 8);
        const results = rawRows.slice(0, effectiveQuarters).map((row, rowIndex) => {
          const previousQuarter = rawRows[rowIndex + 1];
          const previousYearQuarter = rawRows[rowIndex + 4];

          const revenue = toNumber(row.revenue);
          const profit = toNumber(row.net_profit);
          const operatingProfit = toNumber(row.operating_profit);
          const operatingMargin = revenue && operatingProfit !== null && revenue !== 0
            ? roundTo((operatingProfit / revenue) * 100, 2)
            : null;

          const trendWindow = rawRows.slice(rowIndex + 1, rowIndex + 5);
          const trendAverageRevenue = average(
            trendWindow.map((trendRow) => toNumber(trendRow.revenue)).filter((value): value is number => value !== null)
          );

          const trendDeviationPct = trendAverageRevenue !== null && revenue !== null && trendAverageRevenue !== 0
            ? roundTo(((revenue - trendAverageRevenue) / trendAverageRevenue) * 100, 2)
            : null;

          const significantFlags = [
            pctChange(revenue, toNumber(previousQuarter?.revenue)),
            pctChange(revenue, toNumber(previousYearQuarter?.revenue)),
            pctChange(profit, toNumber(previousQuarter?.net_profit)),
            pctChange(profit, toNumber(previousYearQuarter?.net_profit)),
            trendDeviationPct,
          ].filter((value): value is number => value !== null).some((value) => Math.abs(value) > 20);

          return {
            fiscalYear: row.fiscal_year,
            quarter: row.quarter,
            periodEndDate: row.period_end_date,
            revenue,
            netProfit: profit,
            operatingMargin,
            growthPct: {
              revenueQoQ: pctChange(revenue, toNumber(previousQuarter?.revenue)),
              revenueYoY: pctChange(revenue, toNumber(previousYearQuarter?.revenue)),
              profitQoQ: pctChange(profit, toNumber(previousQuarter?.net_profit)),
              profitYoY: pctChange(profit, toNumber(previousYearQuarter?.net_profit)),
            },
            trendDeviationPct,
            significantChange: significantFlags,
          };
        });

        if (results.length > 0) {
          await cacheSet(key, results, TTL.FINANCIAL_DATA);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: results.length > 0
                ? `${company.company_name} (${normalizedTicker}) quarterly results: ${results.length} quarters`
                : `No quarterly results found for ${normalizedTicker}`,
              data: results,
              context: {
                ticker: normalizedTicker,
                period: 'quarterly',
                count: results.length,
                units: {
                  revenue: 'INR Crores',
                  netProfit: 'INR Crores',
                  operatingMargin: 'Percentage',
                  growthPct: 'Percentage',
                },
              },
              relatedTools: ['get_income_statement', 'get_financial_ratios', 'compare_financials', 'get_company_profile'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_quarterly_results',
              err instanceof Error ? err.message : 'Quarterly results fetch failed'
            ),
          }],
        };
      }
    }
  );

  server.tool(
    'compare_financials',
    'Compare financial metrics side-by-side for up to 5 companies and returns a matrix with metrics as rows and companies as columns, plus sector averages for context. Use this for peer benchmarking across selected metrics. For single-company deep dives use get_income_statement or get_financial_ratios. Example: compare_financials({ tickers: ["HDFCBANK", "ICICIBANK"], metrics: ["revenue", "net_profit", "roe"], period: "annual", years: 5 })',
    {
      tickers: z.array(z.string().min(1)).min(2).max(5).describe('2 to 5 company tickers for comparison'),
      metrics: z.array(z.string().min(1)).min(1).max(15).describe('Metric names, e.g. revenue, net_profit, roe, debt_to_equity'),
      period: z.enum(['annual', 'quarterly']).describe('Comparison basis: annual or quarterly'),
      years: z.number().min(1).max(15).optional().describe('Historical depth used to pull latest comparable periods (default 5)'),
    },
    async ({ tickers, metrics, period, years }) => {
      try {
        const normalizedTickers = tickers.map((tickerValue) => normalizeTicker(tickerValue));
        const effectiveYears = years || 5;
        const key = cacheKey('fin-compare', normalizedTickers.join(','), {
          metrics: metrics.map((metric) => normalizeMetricKey(metric)).sort(),
          period,
          years: effectiveYears,
        });

        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Financial comparison for ${normalizedTickers.join(', ')} (cached)`,
                data: cached,
                context: { period, count: Array.isArray(normalizedTickers) ? normalizedTickers.length : undefined },
                relatedTools: ['get_income_statement', 'get_financial_ratios', 'get_company_peers', 'run_screen'],
              }),
            }],
          };
        }

        const comparisonRows: Array<{
          ticker: string;
          companyName: string;
          sector: string | null;
          values: Record<string, number | null>;
          periodLabel: string;
        }> = [];

        const missingTickers: string[] = [];
        for (const normalizedTicker of normalizedTickers) {
          const company = await queries.getCompanyByTicker(db, normalizedTicker);
          if (!company) {
            missingTickers.push(normalizedTicker);
            continue;
          }

          const statementRows = period === 'annual'
            ? await queries.getAnnualFinancials(db, company.id, effectiveYears)
            : await queries.getQuarterlyFinancials(db, company.id, Math.max(effectiveYears * 4, 8));

          const ratioRows = await queries.getRatios(db, company.id, effectiveYears);
          const latestStatement = statementRows[0] || {};
          const latestRatio = ratioRows[0] || {};

          const values: Record<string, number | null> = {};
          for (const metric of metrics) {
            const normalizedMetric = normalizeMetricKey(metric);
            values[normalizedMetric] = metricValueFromRows(normalizedMetric, latestStatement, latestRatio);
          }

          comparisonRows.push({
            ticker: normalizedTicker,
            companyName: company.company_name,
            sector: company.sector || null,
            values,
            periodLabel: period === 'annual'
              ? String(latestStatement.fiscal_year ?? 'N/A')
              : `${latestStatement.fiscal_year ?? 'N/A'} Q${latestStatement.quarter ?? '?'}`,
          });
        }

        if (comparisonRows.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'compare_financials',
                'None of the provided tickers were found.',
                'Use search_companies to confirm ticker symbols before comparing.'
              ),
            }],
          };
        }

        const normalizedMetrics = metrics.map((metric) => normalizeMetricKey(metric));
        const matrix = normalizedMetrics.map((metric) => {
          const row: Record<string, number | null | string> = { metric };
          for (const comparisonRow of comparisonRows) {
            row[comparisonRow.ticker] = comparisonRow.values[metric] ?? null;
          }
          return row;
        });

        const sectorAverages: Record<string, Record<string, number | null>> = {};
        const sectors = Array.from(new Set(comparisonRows.map((row) => row.sector).filter((sector): sector is string => Boolean(sector))));
        for (const sector of sectors) {
          const sectorRows = comparisonRows.filter((row) => row.sector === sector);
          sectorAverages[sector] = {};
          for (const metric of normalizedMetrics) {
            const metricValues = sectorRows
              .map((row) => row.values[metric])
              .filter((value): value is number => value !== null);
            sectorAverages[sector][metric] = average(metricValues);
          }
        }

        const response = {
          period,
          metrics: normalizedMetrics,
          companies: comparisonRows.map((row) => ({
            ticker: row.ticker,
            companyName: row.companyName,
            sector: row.sector,
            period: row.periodLabel,
          })),
          matrix,
          sectorAverages,
          missingTickers,
        };

        await cacheSet(key, response, TTL.FINANCIAL_DATA);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Compared ${comparisonRows.length} companies across ${normalizedMetrics.length} metrics (${period})`,
              data: response,
              context: {
                period,
                count: comparisonRows.length,
                units: {
                  revenue: 'INR Crores',
                  net_profit: 'INR Crores',
                  roe: 'Decimal (0.15 = 15%)',
                  roce: 'Decimal (0.15 = 15%)',
                },
              },
              relatedTools: ['get_income_statement', 'get_financial_ratios', 'get_company_peers', 'run_screen'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'compare_financials',
              err instanceof Error ? err.message : 'Financial comparison failed'
            ),
          }],
        };
      }
    }
  );
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pctChange(currentValue: number | null, previousValue: number | null): number | null {
  if (currentValue === null || previousValue === null || previousValue === 0) {
    return null;
  }
  return roundTo(((currentValue - previousValue) / Math.abs(previousValue)) * 100, 2);
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((accumulator, current) => accumulator + current, 0);
  return roundTo(total / values.length, 2);
}

function normalizeMetricKey(rawMetric: string): string {
  const normalized = rawMetric.trim().toLowerCase();
  const aliases: Record<string, string> = {
    revenue: 'revenue',
    sales: 'revenue',
    expenses: 'expenses',
    operating_profit: 'operating_profit',
    opm: 'operating_margin',
    net_profit: 'net_profit',
    pat: 'net_profit',
    eps: 'eps',
    equity: 'equity_capital',
    reserves: 'reserves',
    borrowings: 'total_borrowings',
    debt: 'total_borrowings',
    total_assets: 'total_assets',
    ocf: 'operating_cash_flow',
    fcf: 'fcf',
    pe: 'pe_ratio',
    pb: 'pb_ratio',
    roe: 'roe',
    roce: 'roce',
    debt_to_equity: 'debt_to_equity',
    current_ratio: 'current_ratio',
    dividend_yield: 'dividend_yield',
    operating_margin: 'operating_margin',
    net_margin: 'net_margin',
    asset_turnover: 'asset_turnover',
    interest_coverage: 'interest_coverage',
    earnings_yield: 'earnings_yield',
    fcf_yield: 'fcf_yield',
  };

  return aliases[normalized] || normalized;
}

function metricValueFromRows(
  normalizedMetric: string,
  latestStatement: Record<string, unknown>,
  latestRatio: Record<string, unknown>
): number | null {
  if (normalizedMetric === 'fcf') {
    const operatingCashFlow = toNumber(latestStatement.operating_cash_flow);
    const capex = toNumber(latestStatement.capex);
    return operatingCashFlow !== null && capex !== null ? roundTo(operatingCashFlow - capex, 2) : null;
  }

  const statementValue = toNumber(latestStatement[normalizedMetric]);
  if (statementValue !== null) {
    return statementValue;
  }

  return toNumber(latestRatio[normalizedMetric]);
}
