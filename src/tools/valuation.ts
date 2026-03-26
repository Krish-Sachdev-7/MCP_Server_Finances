/**
 * Valuation tools -- DCF, multiples, intrinsic value, historical valuations, screener.
 * Phase 3 implementation -- follows the exact pattern from src/tools/company.ts.
 *
 * RISK 7 compliance: Every response includes a disclaimer in the context field.
 * calculate_dcf always returns a 5x5 sensitivity table.
 * calculate_intrinsic_value returns multiple methods (Graham, EPV, asset-based).
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
import { dcfValuation, grahamNumber, cagr } from '../utils/financial-math.js';

// ============================================================
// CONSTANTS
// ============================================================

const VALUATION_DISCLAIMER =
  'This is a mechanical calculation based on historical data and assumed growth rates. ' +
  'It is not investment advice. Actual outcomes depend on factors not captured in this model.';

const DESCRIPTION_SUFFIX = 'Results are illustrative calculations, not investment recommendations.';

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

/**
 * Builds the mandatory 5x5 DCF sensitivity table.
 * Varies growth rate +/-2% (5 steps) and discount rate +/-2% (5 steps).
 */
function buildSensitivityTable(
  params: {
    lastFcf: number;
    growthRate: number;
    discountRate: number;
    terminalGrowthRate: number;
    projectionYears: number;
    sharesOutstanding: number;
    netDebt: number;
  }
): {
  growthRates: number[];
  discountRates: number[];
  table: number[][];
} {
  const growthRates: number[] = [];
  const discountRates: number[] = [];

  for (let i = -2; i <= 2; i++) {
    growthRates.push(roundTo(params.growthRate + i * 0.01, 4));
    discountRates.push(roundTo(params.discountRate + i * 0.01, 4));
  }

  const table: number[][] = [];
  for (const gr of growthRates) {
    const row: number[] = [];
    for (const dr of discountRates) {
      // Guard against terminal growth >= discount rate (infinite value)
      const safeDr = Math.max(dr, gr + 0.01);
      const safeTerminal = Math.min(params.terminalGrowthRate, safeDr - 0.01);
      const result = dcfValuation({
        ...params,
        growthRate: gr,
        discountRate: safeDr,
        terminalGrowthRate: safeTerminal,
      });
      row.push(roundTo(result.intrinsicValue, 2));
    }
    table.push(row);
  }

  return { growthRates, discountRates, table };
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
  // calculate_dcf
  // ------------------------------------------------------------------
  server.tool(
    'calculate_dcf',
    'Calculate a Discounted Cash Flow (DCF) valuation for a company. Returns projected ' +
    'cash flows, terminal value, enterprise value, equity value per share, and a 5x5 ' +
    'sensitivity table varying growth rate and discount rate by +/-2%. Use this for ' +
    'absolute valuation estimates. For relative valuation use get_valuation_metrics; for ' +
    'multiple intrinsic value methods use calculate_intrinsic_value. ' +
    'Example: calculate_dcf({ ticker: "TCS", growthRate: 0.12, discountRate: 0.11 }). ' +
    DESCRIPTION_SUFFIX,
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol, e.g. "TCS", "RELIANCE"'
      ),
      growthRate: z.number().min(0).max(0.5).optional().describe(
        'Expected FCF growth rate as decimal (default: derived from historical CAGR, typically 0.08-0.15)'
      ),
      discountRate: z.number().min(0.01).max(0.3).optional().describe(
        'Weighted average cost of capital as decimal (default 0.11 = 11%)'
      ),
      terminalGrowthRate: z.number().min(0).max(0.08).optional().describe(
        'Long-term perpetuity growth rate as decimal (default 0.04 = 4%)'
      ),
      projectionYears: z.number().min(3).max(20).optional().describe(
        'Number of years to project cash flows (default 10)'
      ),
    },
    async ({ ticker, growthRate, discountRate, terminalGrowthRate, projectionYears }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const dr = discountRate ?? 0.11;
        const tgr = terminalGrowthRate ?? 0.04;
        const years = projectionYears ?? 10;

        const key = cacheKey('dcf', normalized, { growthRate, dr, tgr, years });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `DCF valuation for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized, disclaimer: VALUATION_DISCLAIMER },
                relatedTools: ['get_valuation_metrics', 'calculate_intrinsic_value', 'get_company_profile'],
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
                'calculate_dcf',
                `Company "${normalized}" not found.`,
                suggestions.length > 0
                  ? `Did you mean: ${suggestions.map((s: { ticker: string }) => s.ticker).join(', ')}?`
                  : 'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        // Fetch financials to derive FCF and other inputs
        const annuals = await queries.getAnnualFinancials(db, company.id, 5);
        if (annuals.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'calculate_dcf',
                `No financial data available for ${normalized}.`,
                'Financial data must be ingested before running a DCF. Try get_income_statement to check data availability.'
              ),
            }],
          };
        }

        const latest = annuals[0];
        const ocf = toNumber(latest.operating_cash_flow) ?? 0;
        const capex = Math.abs(toNumber(latest.capex) ?? 0);
        const lastFcf = ocf - capex;
        const borrowings = toNumber(latest.total_borrowings) ?? 0;
        const equity = toNumber(latest.equity_capital) ?? 0;
        const netDebt = borrowings; // simplified: borrowings as net debt proxy

        // Estimate shares outstanding from equity capital + face value
        const faceValue = toNumber(company.face_value) ?? 10;
        const sharesOutstanding = equity > 0 ? (equity / faceValue) : 1;
        const sharesCr = sharesOutstanding; // equity_capital is already in crores, so shares = equity_capital_cr / face_value_cr * 10M

        // Derive growth rate from historical data if not provided
        let gr = growthRate ?? null;
        if (gr === null) {
          if (annuals.length >= 3) {
            const oldestRevenue = toNumber(annuals[annuals.length - 1].revenue);
            const latestRevenue = toNumber(latest.revenue);
            if (oldestRevenue && latestRevenue && oldestRevenue > 0) {
              gr = cagr(oldestRevenue, latestRevenue, annuals.length - 1) ?? 0.10;
            } else {
              gr = 0.10;
            }
          } else {
            gr = 0.10;
          }
        }

        // Core DCF calculation
        const coreResult = dcfValuation({
          lastFcf,
          growthRate: gr,
          discountRate: dr,
          terminalGrowthRate: tgr,
          projectionYears: years,
          sharesOutstanding: sharesCr,
          netDebt,
        });

        // 5x5 sensitivity table (MANDATORY per Risk 7)
        const sensitivity = buildSensitivityTable({
          lastFcf,
          growthRate: gr,
          discountRate: dr,
          terminalGrowthRate: tgr,
          projectionYears: years,
          sharesOutstanding: sharesCr,
          netDebt,
        });

        // Projected cash flows year by year
        const projectedCashFlows: Array<{ year: number; fcf: number; presentValue: number }> = [];
        let projFcf = lastFcf;
        for (let y = 1; y <= years; y++) {
          projFcf *= (1 + gr);
          const pv = projFcf / Math.pow(1 + dr, y);
          projectedCashFlows.push({
            year: y,
            fcf: roundTo(projFcf, 2),
            presentValue: roundTo(pv, 2),
          });
        }

        const latestPrice = await queries.getLatestPrice(db, company.id);
        const currentPrice = toNumber(latestPrice?.close_price);
        const marginOfSafety = currentPrice && coreResult.intrinsicValue > 0
          ? roundTo(((coreResult.intrinsicValue - currentPrice) / coreResult.intrinsicValue) * 100, 2)
          : null;

        const result = {
          ticker: normalized,
          companyName: company.company_name,
          assumptions: {
            lastFcf: roundTo(lastFcf, 2),
            growthRate: roundTo(gr, 4),
            discountRate: roundTo(dr, 4),
            terminalGrowthRate: roundTo(tgr, 4),
            projectionYears: years,
            sharesOutstandingCr: roundTo(sharesCr, 4),
            netDebt: roundTo(netDebt, 2),
          },
          result: {
            intrinsicValuePerShare: roundTo(coreResult.intrinsicValue, 2),
            presentValueOfCashFlows: roundTo(coreResult.presentValueOfCashFlows, 2),
            terminalValue: roundTo(coreResult.terminalValue, 2),
            enterpriseValue: roundTo(coreResult.enterpriseValue, 2),
            currentPrice,
            marginOfSafety,
          },
          projectedCashFlows,
          sensitivityTable: {
            description: 'Intrinsic value per share at varying growth rates (rows) and discount rates (columns)',
            growthRates: sensitivity.growthRates.map((r) => roundTo(r * 100, 2) + '%'),
            discountRates: sensitivity.discountRates.map((r) => roundTo(r * 100, 2) + '%'),
            values: sensitivity.table,
          },
        };

        await cacheSet(key, result, TTL.FINANCIAL_DATA);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `DCF valuation for ${company.company_name} (${normalized}): intrinsic value Rs. ${roundTo(coreResult.intrinsicValue, 2)}${currentPrice ? ` vs current price Rs. ${currentPrice}` : ''}`,
              data: result,
              context: {
                ticker: normalized,
                disclaimer: VALUATION_DISCLAIMER,
                units: {
                  intrinsicValuePerShare: 'INR',
                  presentValueOfCashFlows: 'INR Crores',
                  terminalValue: 'INR Crores',
                  enterpriseValue: 'INR Crores',
                  marginOfSafety: 'Percentage (positive = undervalued)',
                },
              },
              relatedTools: ['get_valuation_metrics', 'calculate_intrinsic_value', 'get_financial_ratios', 'get_cash_flow'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'calculate_dcf',
              err instanceof Error ? err.message : 'DCF calculation failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_valuation_metrics
  // ------------------------------------------------------------------
  server.tool(
    'get_valuation_metrics',
    'Get current and historical valuation multiples for a company: PE, PB, EV/EBITDA, ' +
    'price-to-sales, earnings yield, dividend yield, and FCF yield. Includes 5-year ' +
    'averages and percentile ranks for context. Use this for relative valuation and ' +
    'comparing to historical norms. For absolute valuation use calculate_dcf; for peer ' +
    'comparison use compare_financials. ' +
    'Example: get_valuation_metrics({ ticker: "HDFCBANK" }). ' +
    DESCRIPTION_SUFFIX,
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol, e.g. "HDFCBANK", "ICICIBANK"'
      ),
      years: z.number().min(1).max(15).optional().describe(
        'Historical depth for computing averages (default 5)'
      ),
    },
    async ({ ticker, years }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const effectiveYears = years ?? 5;
        const key = cacheKey('valuation-metrics', normalized, { years: effectiveYears });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Valuation metrics for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized, disclaimer: VALUATION_DISCLAIMER },
                relatedTools: ['calculate_dcf', 'calculate_intrinsic_value', 'get_financial_ratios'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_valuation_metrics',
                `Company "${normalized}" not found.`,
                'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        const ratioRows = await queries.getRatios(db, company.id, effectiveYears);
        if (ratioRows.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_valuation_metrics',
                `No ratio data available for ${normalized}.`,
                'Try get_income_statement to check if financial data exists.'
              ),
            }],
          };
        }

        const latestPrice = await queries.getLatestPrice(db, company.id);
        const latestRatio = ratioRows[0];

        // Compute averages and ranges from history
        const metrics = ['pe_ratio', 'pb_ratio', 'ev_ebitda', 'price_to_sales', 'earnings_yield', 'dividend_yield', 'fcf_yield'] as const;

        const stats: Record<string, {
          current: number | null;
          avg: number | null;
          min: number | null;
          max: number | null;
          median: number | null;
          percentileRank: number | null;
        }> = {};

        for (const metric of metrics) {
          const values = ratioRows
            .map((r) => toNumber(r[metric]))
            .filter((v): v is number => v !== null);

          const current = toNumber(latestRatio[metric]);
          const sorted = [...values].sort((a, b) => a - b);

          stats[metric] = {
            current,
            avg: values.length > 0 ? roundTo(values.reduce((a, b) => a + b, 0) / values.length, 4) : null,
            min: sorted.length > 0 ? sorted[0] : null,
            max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
            median: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null,
            percentileRank: current !== null && sorted.length > 1
              ? roundTo((sorted.filter((v) => v <= current).length / sorted.length) * 100, 1)
              : null,
          };
        }

        const result = {
          ticker: normalized,
          companyName: company.company_name,
          currentPrice: toNumber(latestPrice?.close_price),
          priceDate: latestPrice?.trade_date ?? null,
          marketCapCr: toNumber(company.market_cap_cr),
          fiscalYear: latestRatio.fiscal_year,
          metrics: stats,
          yearsOfHistory: ratioRows.length,
        };

        await cacheSet(key, result, TTL.FINANCIAL_DATA);

        const pe = stats.pe_ratio.current;
        const peAvg = stats.pe_ratio.avg;
        const peLabel = pe !== null
          ? `PE ${roundTo(pe, 1)}x${peAvg ? ` (${effectiveYears}Y avg: ${roundTo(peAvg, 1)}x)` : ''}`
          : 'PE N/A';

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${company.company_name} (${normalized}) valuation: ${peLabel}`,
              data: result,
              context: {
                ticker: normalized,
                disclaimer: VALUATION_DISCLAIMER,
                units: {
                  pe_ratio: 'x (times)',
                  pb_ratio: 'x (times)',
                  ev_ebitda: 'x (times)',
                  earnings_yield: 'Decimal (0.05 = 5%)',
                  dividend_yield: 'Decimal (0.03 = 3%)',
                  fcf_yield: 'Decimal',
                  percentileRank: '0-100 (higher = more expensive vs history)',
                },
              },
              relatedTools: ['calculate_dcf', 'calculate_intrinsic_value', 'get_historical_valuations', 'compare_financials'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_valuation_metrics',
              err instanceof Error ? err.message : 'Valuation metrics fetch failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // calculate_intrinsic_value
  // ------------------------------------------------------------------
  server.tool(
    'calculate_intrinsic_value',
    'Calculate intrinsic value using multiple methods: Graham Number, Earnings Power ' +
    'Value (EPV), asset-based (book value), and DCF. Returns a range of estimates so ' +
    'the user can see how different assumptions produce different outcomes. Use this ' +
    'for a comprehensive intrinsic value estimate. For DCF-only with sensitivity table ' +
    'use calculate_dcf. For current multiples use get_valuation_metrics. ' +
    'Example: calculate_intrinsic_value({ ticker: "INFY" }). ' +
    DESCRIPTION_SUFFIX,
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol, e.g. "INFY", "RELIANCE"'
      ),
      discountRate: z.number().min(0.01).max(0.3).optional().describe(
        'Discount rate for EPV and DCF methods (default 0.11 = 11%)'
      ),
    },
    async ({ ticker, discountRate }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const dr = discountRate ?? 0.11;
        const key = cacheKey('intrinsic-value', normalized, { dr });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Intrinsic value for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized, disclaimer: VALUATION_DISCLAIMER },
                relatedTools: ['calculate_dcf', 'get_valuation_metrics', 'get_company_profile'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'calculate_intrinsic_value',
                `Company "${normalized}" not found.`,
                'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        const annuals = await queries.getAnnualFinancials(db, company.id, 5);
        const latestPrice = await queries.getLatestPrice(db, company.id);
        const currentPrice = toNumber(latestPrice?.close_price);

        if (annuals.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'calculate_intrinsic_value',
                `No financial data available for ${normalized}.`,
                'Financial data must be ingested first.'
              ),
            }],
          };
        }

        const latest = annuals[0];
        const eps = toNumber(latest.eps) ?? 0;
        const equity = toNumber(latest.equity_capital) ?? 0;
        const reserves = toNumber(latest.reserves) ?? 0;
        const faceValue = toNumber(company.face_value) ?? 10;
        const sharesOutstandingCr = equity > 0 ? equity / faceValue : 1;
        const bvps = sharesOutstandingCr > 0 ? (equity + reserves) / sharesOutstandingCr : 0;
        const netProfit = toNumber(latest.net_profit) ?? 0;
        const ocf = toNumber(latest.operating_cash_flow) ?? 0;
        const capex = Math.abs(toNumber(latest.capex) ?? 0);
        const lastFcf = ocf - capex;
        const borrowings = toNumber(latest.total_borrowings) ?? 0;
        const totalAssets = toNumber(latest.total_assets) ?? 0;

        // Method 1: Graham Number
        const graham = grahamNumber(eps, bvps);

        // Method 2: Earnings Power Value (EPV)
        // EPV = Normalized Earnings / Cost of Capital
        const avgNetProfit = annuals.length > 0
          ? annuals.reduce((sum, r) => sum + (toNumber(r.net_profit) ?? 0), 0) / annuals.length
          : netProfit;
        const epvEnterprise = dr > 0 ? avgNetProfit / dr : 0;
        const epvEquity = epvEnterprise - borrowings;
        const epvPerShare = sharesOutstandingCr > 0 ? Math.max(0, epvEquity / sharesOutstandingCr) : 0;

        // Method 3: Asset-based (book value)
        const netAssetValue = totalAssets - borrowings - (toNumber(latest.other_liabilities) ?? 0);
        const assetBasedPerShare = sharesOutstandingCr > 0 ? Math.max(0, netAssetValue / sharesOutstandingCr) : 0;

        // Method 4: DCF (simplified, using historical CAGR)
        let dcfGrowthRate = 0.10;
        if (annuals.length >= 3) {
          const oldestRevenue = toNumber(annuals[annuals.length - 1].revenue);
          const latestRevenue = toNumber(latest.revenue);
          if (oldestRevenue && latestRevenue && oldestRevenue > 0) {
            dcfGrowthRate = cagr(oldestRevenue, latestRevenue, annuals.length - 1) ?? 0.10;
          }
        }
        const dcfResult = dcfValuation({
          lastFcf,
          growthRate: dcfGrowthRate,
          discountRate: dr,
          terminalGrowthRate: 0.04,
          projectionYears: 10,
          sharesOutstanding: sharesOutstandingCr,
          netDebt: borrowings,
        });

        const methods = [
          { method: 'Graham Number', value: graham !== null ? roundTo(graham, 2) : null, description: 'sqrt(22.5 * EPS * BVPS). Conservative estimate based on earnings and book value.' },
          { method: 'Earnings Power Value', value: roundTo(epvPerShare, 2), description: 'Avg net profit / discount rate. Assumes no growth, values current earning power only.' },
          { method: 'Asset-Based (Book Value)', value: roundTo(assetBasedPerShare, 2), description: 'Net asset value / shares. Floor valuation based on balance sheet.' },
          { method: 'DCF (10-year)', value: roundTo(dcfResult.intrinsicValue, 2), description: `DCF with ${roundTo(dcfGrowthRate * 100, 1)}% growth, ${roundTo(dr * 100, 1)}% WACC, 4% terminal growth.` },
        ];

        const validValues = methods.map((m) => m.value).filter((v): v is number => v !== null && v > 0);
        const avgIntrinsicValue = validValues.length > 0
          ? roundTo(validValues.reduce((a, b) => a + b, 0) / validValues.length, 2)
          : null;
        const minIntrinsicValue = validValues.length > 0 ? Math.min(...validValues) : null;
        const maxIntrinsicValue = validValues.length > 0 ? Math.max(...validValues) : null;

        const result = {
          ticker: normalized,
          companyName: company.company_name,
          currentPrice,
          methods,
          summary: {
            averageIntrinsicValue: avgIntrinsicValue,
            range: { min: minIntrinsicValue, max: maxIntrinsicValue },
            marginOfSafety: currentPrice && avgIntrinsicValue
              ? roundTo(((avgIntrinsicValue - currentPrice) / avgIntrinsicValue) * 100, 2)
              : null,
          },
          inputs: {
            eps: roundTo(eps, 2),
            bvps: roundTo(bvps, 2),
            avgNetProfitCr: roundTo(avgNetProfit, 2),
            lastFcfCr: roundTo(lastFcf, 2),
            discountRate: dr,
            sharesOutstandingCr: roundTo(sharesOutstandingCr, 4),
          },
        };

        await cacheSet(key, result, TTL.FINANCIAL_DATA);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${company.company_name} (${normalized}) intrinsic value range: Rs. ${minIntrinsicValue ?? 'N/A'} to Rs. ${maxIntrinsicValue ?? 'N/A'}${currentPrice ? ` (current price: Rs. ${currentPrice})` : ''}`,
              data: result,
              context: {
                ticker: normalized,
                disclaimer: VALUATION_DISCLAIMER,
                units: {
                  intrinsicValue: 'INR per share',
                  marginOfSafety: 'Percentage (positive = undervalued)',
                  avgNetProfitCr: 'INR Crores',
                  lastFcfCr: 'INR Crores',
                },
              },
              relatedTools: ['calculate_dcf', 'get_valuation_metrics', 'get_financial_ratios', 'get_company_peers'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'calculate_intrinsic_value',
              err instanceof Error ? err.message : 'Intrinsic value calculation failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_historical_valuations
  // ------------------------------------------------------------------
  server.tool(
    'get_historical_valuations',
    'Get historical valuation multiples (PE, PB, EV/EBITDA) year by year for a company, ' +
    'showing how the market has valued it over time. Includes min/max/avg bands. Use this ' +
    'to understand if a stock is trading above or below its historical valuation range. ' +
    'For current snapshot use get_valuation_metrics. For screening by valuation use ' +
    'valuation_screener. ' +
    'Example: get_historical_valuations({ ticker: "RELIANCE", years: 10 }). ' +
    DESCRIPTION_SUFFIX,
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol'
      ),
      years: z.number().min(2).max(15).optional().describe(
        'Years of history (default 10)'
      ),
    },
    async ({ ticker, years }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const effectiveYears = years ?? 10;
        const key = cacheKey('hist-valuation', normalized, { years: effectiveYears });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Historical valuations for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized, disclaimer: VALUATION_DISCLAIMER },
                relatedTools: ['get_valuation_metrics', 'calculate_dcf', 'get_financial_ratios'],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_historical_valuations',
                `Company "${normalized}" not found.`,
                'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        const ratioRows = await queries.getRatios(db, company.id, effectiveYears);
        if (ratioRows.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_historical_valuations',
                `No historical data available for ${normalized}.`
              ),
            }],
          };
        }

        const history = ratioRows.map((row) => ({
          fiscalYear: row.fiscal_year,
          pe: toNumber(row.pe_ratio),
          pb: toNumber(row.pb_ratio),
          evEbitda: toNumber(row.ev_ebitda),
          earningsYield: toNumber(row.earnings_yield),
          dividendYield: toNumber(row.dividend_yield),
          priceToSales: toNumber(row.price_to_sales),
        }));

        // Compute bands
        const peValues = history.map((h) => h.pe).filter((v): v is number => v !== null);
        const pbValues = history.map((h) => h.pb).filter((v): v is number => v !== null);

        const computeBand = (values: number[]) => {
          if (values.length === 0) return { min: null, max: null, avg: null, current: null };
          const sorted = [...values].sort((a, b) => a - b);
          return {
            min: sorted[0],
            max: sorted[sorted.length - 1],
            avg: roundTo(values.reduce((a, b) => a + b, 0) / values.length, 2),
            current: values[0], // most recent is first (DESC order from query)
          };
        };

        const bands = {
          pe: computeBand(peValues),
          pb: computeBand(pbValues),
        };

        const result = {
          ticker: normalized,
          companyName: company.company_name,
          history,
          bands,
          yearsOfData: history.length,
        };

        await cacheSet(key, result, TTL.FINANCIAL_DATA);

        const peInfo = bands.pe.current !== null
          ? `current PE ${roundTo(bands.pe.current, 1)}x (${effectiveYears}Y range: ${bands.pe.min !== null ? roundTo(bands.pe.min, 1) : 'N/A'}-${bands.pe.max !== null ? roundTo(bands.pe.max, 1) : 'N/A'}x)`
          : 'PE data not available';

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${company.company_name} (${normalized}) historical valuations: ${peInfo}`,
              data: result,
              context: {
                ticker: normalized,
                disclaimer: VALUATION_DISCLAIMER,
                units: {
                  pe: 'x (times)',
                  pb: 'x (times)',
                  evEbitda: 'x (times)',
                  earningsYield: 'Decimal',
                  dividendYield: 'Decimal',
                },
              },
              relatedTools: ['get_valuation_metrics', 'calculate_dcf', 'valuation_screener', 'get_company_peers'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_historical_valuations',
              err instanceof Error ? err.message : 'Historical valuations fetch failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // valuation_screener
  // ------------------------------------------------------------------
  server.tool(
    'valuation_screener',
    'Screen for stocks by valuation criteria. Filter by PE, PB, EV/EBITDA, dividend ' +
    'yield, earnings yield, and FCF yield ranges. Returns companies matching all conditions ' +
    'sorted by the chosen metric. Use this to find undervalued or overvalued stocks. For ' +
    'broader multi-metric screening use run_screen. For single-company valuation use ' +
    'get_valuation_metrics. ' +
    'Example: valuation_screener({ peMax: 15, pbMax: 2, dividendYieldMin: 0.03 }). ' +
    DESCRIPTION_SUFFIX,
    {
      peMin: z.number().optional().describe('Minimum PE ratio'),
      peMax: z.number().optional().describe('Maximum PE ratio'),
      pbMin: z.number().optional().describe('Minimum PB ratio'),
      pbMax: z.number().optional().describe('Maximum PB ratio'),
      evEbitdaMax: z.number().optional().describe('Maximum EV/EBITDA'),
      dividendYieldMin: z.number().optional().describe('Minimum dividend yield as decimal (0.03 = 3%)'),
      earningsYieldMin: z.number().optional().describe('Minimum earnings yield as decimal'),
      fcfYieldMin: z.number().optional().describe('Minimum FCF yield as decimal'),
      sector: z.string().optional().describe('Filter by sector name'),
      sortBy: z.enum(['pe_ratio', 'pb_ratio', 'ev_ebitda', 'dividend_yield', 'earnings_yield', 'fcf_yield', 'market_cap_cr']).optional().describe('Sort column (default pe_ratio)'),
      sortOrder: z.enum(['ASC', 'DESC']).optional().describe('Sort direction (default ASC for valuation metrics)'),
      limit: z.number().min(1).max(100).optional().describe('Max results (default 25)'),
    },
    async (params) => {
      try {
        const {
          peMin, peMax, pbMin, pbMax, evEbitdaMax,
          dividendYieldMin, earningsYieldMin, fcfYieldMin,
          sector, sortBy, sortOrder, limit,
        } = params;

        const key = cacheKey('valuation-screen', 'query', params);
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Valuation screen results (cached)`,
                data: cached,
                context: { disclaimer: VALUATION_DISCLAIMER },
                relatedTools: ['get_valuation_metrics', 'calculate_intrinsic_value', 'run_screen'],
              }),
            }],
          };
        }

        // Build WHERE clause from parameters
        const conditions: string[] = [];
        const queryParams: unknown[] = [];
        let paramIdx = 1;

        if (peMin !== undefined) {
          conditions.push(`r.pe_ratio >= $${paramIdx}`);
          queryParams.push(peMin);
          paramIdx++;
        }
        if (peMax !== undefined) {
          conditions.push(`r.pe_ratio <= $${paramIdx}`);
          queryParams.push(peMax);
          paramIdx++;
        }
        if (pbMin !== undefined) {
          conditions.push(`r.pb_ratio >= $${paramIdx}`);
          queryParams.push(pbMin);
          paramIdx++;
        }
        if (pbMax !== undefined) {
          conditions.push(`r.pb_ratio <= $${paramIdx}`);
          queryParams.push(pbMax);
          paramIdx++;
        }
        if (evEbitdaMax !== undefined) {
          conditions.push(`r.ev_ebitda <= $${paramIdx}`);
          queryParams.push(evEbitdaMax);
          paramIdx++;
        }
        if (dividendYieldMin !== undefined) {
          conditions.push(`r.dividend_yield >= $${paramIdx}`);
          queryParams.push(dividendYieldMin);
          paramIdx++;
        }
        if (earningsYieldMin !== undefined) {
          conditions.push(`r.earnings_yield >= $${paramIdx}`);
          queryParams.push(earningsYieldMin);
          paramIdx++;
        }
        if (fcfYieldMin !== undefined) {
          conditions.push(`r.fcf_yield >= $${paramIdx}`);
          queryParams.push(fcfYieldMin);
          paramIdx++;
        }
        if (sector) {
          conditions.push(`c.sector = $${paramIdx}`);
          queryParams.push(sector);
          paramIdx++;
        }

        // Ensure we only look at latest year ratios and PE > 0 (exclude negative earnings)
        conditions.push(`r.pe_ratio > 0`);

        const effectiveSortBy = sortBy ?? 'pe_ratio';
        const effectiveSortOrder = sortOrder ?? 'ASC';
        const effectiveLimit = limit ?? 25;

        // Validate sort column against allowlist
        const allowedSorts = ['pe_ratio', 'pb_ratio', 'ev_ebitda', 'dividend_yield', 'earnings_yield', 'fcf_yield', 'market_cap_cr'];
        const safeSortBy = allowedSorts.includes(effectiveSortBy) ? effectiveSortBy : 'pe_ratio';
        const safeSortOrder = effectiveSortOrder === 'DESC' ? 'DESC' : 'ASC';

        const whereClause = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';

        const sql = `
          SELECT c.ticker, c.company_name, c.sector, c.industry, c.market_cap_cr,
                 r.pe_ratio, r.pb_ratio, r.ev_ebitda, r.dividend_yield, r.earnings_yield,
                 r.fcf_yield, r.roe, r.roce, r.fiscal_year
          FROM companies c
          JOIN ratios r ON c.id = r.company_id
          WHERE c.is_active = TRUE
            AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id)
            AND ${whereClause}
          ORDER BY ${safeSortBy === 'market_cap_cr' ? 'c.' : 'r.'}${safeSortBy} ${safeSortOrder} NULLS LAST
          LIMIT $${paramIdx}
        `;
        queryParams.push(effectiveLimit);

        const { rows } = await db.query(sql, queryParams);

        const results = rows.map((row) => ({
          ticker: row.ticker,
          companyName: row.company_name,
          sector: row.sector,
          industry: row.industry,
          marketCapCr: toNumber(row.market_cap_cr),
          pe: toNumber(row.pe_ratio),
          pb: toNumber(row.pb_ratio),
          evEbitda: toNumber(row.ev_ebitda),
          dividendYield: toNumber(row.dividend_yield),
          earningsYield: toNumber(row.earnings_yield),
          fcfYield: toNumber(row.fcf_yield),
          roe: toNumber(row.roe),
          roce: toNumber(row.roce),
          fiscalYear: row.fiscal_year,
        }));

        const filtersApplied = [];
        if (peMin !== undefined || peMax !== undefined) filtersApplied.push(`PE ${peMin ?? ''}${peMin !== undefined && peMax !== undefined ? '-' : ''}${peMax ?? ''}`);
        if (pbMin !== undefined || pbMax !== undefined) filtersApplied.push(`PB ${pbMin ?? ''}${pbMin !== undefined && pbMax !== undefined ? '-' : ''}${pbMax ?? ''}`);
        if (evEbitdaMax !== undefined) filtersApplied.push(`EV/EBITDA < ${evEbitdaMax}`);
        if (dividendYieldMin !== undefined) filtersApplied.push(`DivYield > ${roundTo(dividendYieldMin * 100, 1)}%`);
        if (sector) filtersApplied.push(`Sector: ${sector}`);

        await cacheSet(key, results, TTL.SCREEN_RESULTS);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Valuation screen: ${results.length} stocks found${filtersApplied.length > 0 ? ` (${filtersApplied.join(', ')})` : ''}`,
              data: results,
              context: {
                disclaimer: VALUATION_DISCLAIMER,
                count: results.length,
                units: {
                  pe: 'x (times)',
                  pb: 'x (times)',
                  evEbitda: 'x (times)',
                  dividendYield: 'Decimal (0.03 = 3%)',
                  marketCapCr: 'INR Crores',
                },
              },
              relatedTools: ['get_valuation_metrics', 'calculate_intrinsic_value', 'run_screen', 'get_company_profile'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'valuation_screener',
              err instanceof Error ? err.message : 'Valuation screening failed'
            ),
          }],
        };
      }
    }
  );
}
