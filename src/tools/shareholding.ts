/**
 * Shareholding tools -- get_shareholding_pattern, get_shareholding_changes,
 * get_insider_trades, get_bulk_block_deals.
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
  normalizeTicker,
} from '../utils/response-builder.js';

/** Shareholding data changes slowly; 1 hour is a reasonable cache TTL. */
const SH_TTL = TTL.FINANCIAL_DATA;

/** Round a numeric value to 2 decimal places. */
function round2(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function registerTools(
  server: McpServer,
  db: Pool,
  _cache: RedisClient
): void {

  // ------------------------------------------------------------------
  // get_shareholding_pattern
  // ------------------------------------------------------------------
  server.tool(
    'get_shareholding_pattern',
    'Get the quarterly shareholding breakdown for an Indian listed company showing ' +
    'promoter, FII, DII, public, and government holdings plus pledged percentage. ' +
    'Returns up to 8 quarters by default so you can see trends. ' +
    'Use this to check ownership concentration, FII/DII interest, and pledge risk. ' +
    'Example: get_shareholding_pattern({ ticker: "RELIANCE" })',
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol, e.g. "RELIANCE", "TCS". .NS/.BO suffixes stripped automatically.'
      ),
      quarters: z.number().min(1).max(40).optional().describe(
        'Number of quarters to return (default 8, max 40 for 10-year history)'
      ),
    },
    async ({ ticker, quarters }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const q = quarters ?? 8;
        const key = cacheKey('shareholding', normalized, { quarters: q });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Shareholding pattern for ${normalized} -- ${q} quarters (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['get_shareholding_changes', 'get_insider_trades', 'get_company_profile'],
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
                'get_shareholding_pattern',
                `Company "${normalized}" not found.`,
                suggestions.length > 0
                  ? `Did you mean: ${suggestions.map((s: { ticker: string }) => s.ticker).join(', ')}?`
                  : 'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        const rows = await queries.getShareholdingPattern(db, company.id, q);

        if (rows.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_shareholding_pattern',
                `No shareholding data available for ${normalized}.`,
                'Data may not have been ingested yet for this company.'
              ),
            }],
          };
        }

        const formatted = rows.map((r: Record<string, unknown>) => ({
          quarter_end_date: r.quarter_end_date,
          promoter_holding: round2(r.promoter_holding),
          fii_holding: round2(r.fii_holding),
          dii_holding: round2(r.dii_holding),
          public_holding: round2(r.public_holding),
          government_holding: round2(r.government_holding),
          pledged_percentage: round2(r.pledged_percentage),
          total_shares: r.total_shares,
        }));

        const latest = formatted[0];
        const result = {
          ticker: normalized,
          companyName: company.company_name,
          quartersReturned: formatted.length,
          holdings: formatted,
        };

        await cacheSet(key, result, SH_TTL);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${company.company_name} (${normalized}) -- Promoter: ${latest.promoter_holding}%, FII: ${latest.fii_holding}%, DII: ${latest.dii_holding}%, Public: ${latest.public_holding}%`,
              data: result,
              context: {
                ticker: normalized,
                units: { holdings: 'Percentage (%)', total_shares: 'Number of shares' },
              },
              relatedTools: [
                'get_shareholding_changes',
                'get_insider_trades',
                'get_company_profile',
                'get_bulk_block_deals',
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_shareholding_pattern',
              err instanceof Error ? err.message : 'Shareholding lookup failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_shareholding_changes
  // ------------------------------------------------------------------
  server.tool(
    'get_shareholding_changes',
    'Compare shareholding patterns between two quarters to see how promoter, FII, ' +
    'DII, and public holdings changed. Highlights significant moves (>1% change). ' +
    'Use this to detect institutional accumulation/distribution or promoter pledge changes. ' +
    'Example: get_shareholding_changes({ ticker: "HDFCBANK", quarters: 4 })',
    {
      ticker: z.string().min(1).describe('Company ticker symbol'),
      quarters: z.number().min(2).max(40).optional().describe(
        'Number of quarters to analyze for changes (default 4). Compares each quarter to the previous one.'
      ),
    },
    async ({ ticker, quarters }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const q = quarters ?? 4;
        const key = cacheKey('sh-changes', normalized, { quarters: q });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Shareholding changes for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['get_shareholding_pattern', 'get_insider_trades'],
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
                'get_shareholding_changes',
                `Company "${normalized}" not found.`,
                'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        // Fetch one extra quarter so we can compute diffs for all requested quarters
        const rows = await queries.getShareholdingPattern(db, company.id, q + 1);

        if (rows.length < 2) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_shareholding_changes',
                `Need at least 2 quarters of data to compute changes. Found ${rows.length} quarter(s) for ${normalized}.`
              ),
            }],
          };
        }

        const changes: Array<Record<string, unknown>> = [];
        for (let i = 0; i < rows.length - 1; i++) {
          const curr = rows[i] as Record<string, unknown>;
          const prev = rows[i + 1] as Record<string, unknown>;

          const diff = (field: string): number | null => {
            const c = round2(curr[field]);
            const p = round2(prev[field]);
            if (c === null || p === null) return null;
            return round2(c - p);
          };

          const promoterDiff = diff('promoter_holding');
          const fiiDiff = diff('fii_holding');
          const diiDiff = diff('dii_holding');
          const publicDiff = diff('public_holding');
          const pledgeDiff = diff('pledged_percentage');

          const significant: string[] = [];
          if (promoterDiff !== null && Math.abs(promoterDiff) >= 1) significant.push(`Promoter ${promoterDiff > 0 ? '+' : ''}${promoterDiff}%`);
          if (fiiDiff !== null && Math.abs(fiiDiff) >= 1) significant.push(`FII ${fiiDiff > 0 ? '+' : ''}${fiiDiff}%`);
          if (diiDiff !== null && Math.abs(diiDiff) >= 1) significant.push(`DII ${diiDiff > 0 ? '+' : ''}${diiDiff}%`);
          if (pledgeDiff !== null && Math.abs(pledgeDiff) >= 0.5) significant.push(`Pledge ${pledgeDiff > 0 ? '+' : ''}${pledgeDiff}%`);

          changes.push({
            from_quarter: prev.quarter_end_date,
            to_quarter: curr.quarter_end_date,
            promoter_change: promoterDiff,
            fii_change: fiiDiff,
            dii_change: diiDiff,
            public_change: publicDiff,
            pledge_change: pledgeDiff,
            significant_moves: significant.length > 0 ? significant : null,
          });
        }

        const result = {
          ticker: normalized,
          companyName: company.company_name,
          periodsCompared: changes.length,
          changes,
        };

        await cacheSet(key, result, SH_TTL);

        const latestChange = changes[0];
        const moveSummary = latestChange.significant_moves
          ? ` Notable: ${(latestChange.significant_moves as string[]).join(', ')}.`
          : ' No significant moves (all <1%).';

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Shareholding changes for ${normalized} over ${changes.length} quarter(s).${moveSummary}`,
              data: result,
              context: {
                ticker: normalized,
                units: { changes: 'Percentage point change (pp)' },
                note: 'Significant moves are changes >= 1pp for holdings or >= 0.5pp for pledges.',
              },
              relatedTools: [
                'get_shareholding_pattern',
                'get_insider_trades',
                'get_bulk_block_deals',
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_shareholding_changes',
              err instanceof Error ? err.message : 'Shareholding changes lookup failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_insider_trades
  // ------------------------------------------------------------------
  server.tool(
    'get_insider_trades',
    'Get recent insider trades (SAST disclosures) for a company or across the market. ' +
    'Shows who bought or sold, how many shares, and the value. Filter by ticker, ' +
    'transaction type, and time period. Use this to spot promoter buying/selling signals. ' +
    'Example: get_insider_trades({ ticker: "INFY", days: 90 })',
    {
      ticker: z.string().optional().describe(
        'Company ticker to filter by. Omit for market-wide insider trades.'
      ),
      days: z.number().min(1).max(365).optional().describe(
        'Lookback period in days (default 30)'
      ),
      transactionType: z.enum(['buy', 'sell', 'all']).optional().describe(
        'Filter by buy, sell, or all (default all)'
      ),
    },
    async ({ ticker, days, transactionType }) => {
      try {
        const d = days ?? 30;
        const txType = transactionType ?? 'all';
        let companyId: number | undefined;
        let normalized: string | undefined;

        if (ticker) {
          normalized = normalizeTicker(ticker);
          const company = await queries.getCompanyByTicker(db, normalized);
          if (!company) {
            return {
              content: [{
                type: 'text' as const,
                text: buildErrorResponse(
                  'get_insider_trades',
                  `Company "${normalized}" not found.`,
                  'Use search_companies to find the correct ticker.'
                ),
              }],
            };
          }
          companyId = company.id;
        }

        const key = cacheKey('insider-trades', normalized ?? 'market', { days: d, txType });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Insider trades${normalized ? ` for ${normalized}` : ''} -- last ${d} days (cached)`,
                data: cached,
                context: { ticker: normalized ?? 'all' },
                relatedTools: ['get_shareholding_pattern', 'get_bulk_block_deals'],
              }),
            }],
          };
        }

        const trades = await queries.getInsiderTrades(db, {
          companyId,
          days: d,
          transactionType: txType,
        });

        const totalBuys = trades.filter((t: Record<string, unknown>) => t.transaction_type === 'buy').length;
        const totalSells = trades.filter((t: Record<string, unknown>) => t.transaction_type === 'sell').length;

        const result = {
          ticker: normalized ?? 'all',
          period: `Last ${d} days`,
          totalTrades: trades.length,
          buys: totalBuys,
          sells: totalSells,
          trades,
        };

        if (trades.length > 0) {
          await cacheSet(key, result, TTL.LATEST_PRICE); // short TTL, trades update frequently
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${trades.length} insider trade(s)${normalized ? ` for ${normalized}` : ''} in last ${d} days -- ${totalBuys} buys, ${totalSells} sells`,
              data: result,
              context: {
                ticker: normalized ?? 'all',
                units: { value_cr: 'INR Crores', shares: 'Number of shares' },
              },
              relatedTools: [
                'get_shareholding_pattern',
                'get_shareholding_changes',
                'get_bulk_block_deals',
                'get_company_profile',
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_insider_trades',
              err instanceof Error ? err.message : 'Insider trades lookup failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_bulk_block_deals
  // ------------------------------------------------------------------
  server.tool(
    'get_bulk_block_deals',
    'Get recent bulk and block deals -- large-value transactions that indicate ' +
    'institutional buying or selling interest. Filter by ticker, lookback period, ' +
    'and minimum transaction value. Use this to find major ownership changes. ' +
    'Example: get_bulk_block_deals({ days: 30, minValueCr: 10 })',
    {
      ticker: z.string().optional().describe(
        'Company ticker to filter by. Omit for market-wide deals.'
      ),
      days: z.number().min(1).max(365).optional().describe(
        'Lookback period in days (default 30)'
      ),
      minValueCr: z.number().min(0).optional().describe(
        'Minimum deal value in crores (default 1). Use higher values like 10 or 50 for only the biggest deals.'
      ),
    },
    async ({ ticker, days, minValueCr }) => {
      try {
        const d = days ?? 30;
        const minVal = minValueCr ?? 1;
        let companyId: number | undefined;
        let normalized: string | undefined;

        if (ticker) {
          normalized = normalizeTicker(ticker);
          const company = await queries.getCompanyByTicker(db, normalized);
          if (!company) {
            return {
              content: [{
                type: 'text' as const,
                text: buildErrorResponse(
                  'get_bulk_block_deals',
                  `Company "${normalized}" not found.`,
                  'Use search_companies to find the correct ticker.'
                ),
              }],
            };
          }
          companyId = company.id;
        }

        const key = cacheKey('bulk-block', normalized ?? 'market', { days: d, minVal });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Bulk/block deals${normalized ? ` for ${normalized}` : ''} (cached)`,
                data: cached,
                context: { ticker: normalized ?? 'all' },
                relatedTools: ['get_insider_trades', 'get_shareholding_changes'],
              }),
            }],
          };
        }

        const deals = await queries.getBulkBlockDeals(db, {
          companyId,
          days: d,
          minValueCr: minVal,
        });

        const totalValueCr = deals.reduce(
          (sum: number, d: Record<string, unknown>) => {
            const v = typeof d.value_cr === 'number' ? d.value_cr : parseFloat(String(d.value_cr ?? 0));
            return sum + (isFinite(v) ? v : 0);
          },
          0
        );

        const result = {
          ticker: normalized ?? 'all',
          period: `Last ${d} days`,
          minValueFilter: `${minVal} Cr`,
          totalDeals: deals.length,
          totalValueCr: Math.round(totalValueCr * 100) / 100,
          deals,
        };

        if (deals.length > 0) {
          await cacheSet(key, result, TTL.LATEST_PRICE);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${deals.length} bulk/block deal(s)${normalized ? ` for ${normalized}` : ''} in last ${d} days (>= ${minVal} Cr) -- total value: ${Math.round(totalValueCr)} Cr`,
              data: result,
              context: {
                ticker: normalized ?? 'all',
                units: { value_cr: 'INR Crores', shares: 'Number of shares' },
                note: 'Bulk deals are exchange-reported trades exceeding 0.5% of equity. Block deals are single trades of 5 lakh+ shares at a fixed price.',
              },
              relatedTools: [
                'get_insider_trades',
                'get_shareholding_changes',
                'get_shareholding_pattern',
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_bulk_block_deals',
              err instanceof Error ? err.message : 'Bulk/block deals lookup failed'
            ),
          }],
        };
      }
    }
  );
}
