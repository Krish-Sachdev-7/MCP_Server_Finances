/**
 * Corporate action tools -- get_dividends, get_stock_splits_bonuses,
 * get_upcoming_events.
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

/** Corporate actions update infrequently; 1 hour cache. */
const CA_TTL = TTL.FINANCIAL_DATA;

export function registerTools(
  server: McpServer,
  db: Pool,
  _cache: RedisClient
): void {

  // ------------------------------------------------------------------
  // get_dividends
  // ------------------------------------------------------------------
  server.tool(
    'get_dividends',
    'Get the dividend history for an Indian listed company including ex-dates, record ' +
    'dates, and dividend amounts per share. Returns all dividends on record, sorted by ' +
    'date (most recent first). Use this to analyze dividend yield consistency, payout ' +
    'growth, and income potential. ' +
    'Example: get_dividends({ ticker: "ITC" })',
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol, e.g. "ITC", "COALINDIA". .NS/.BO suffixes stripped automatically.'
      ),
    },
    async ({ ticker }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const key = cacheKey('dividends', normalized);
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Dividend history for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['get_stock_splits_bonuses', 'get_company_profile', 'get_financial_ratios'],
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
                'get_dividends',
                `Company "${normalized}" not found.`,
                suggestions.length > 0
                  ? `Did you mean: ${suggestions.map((s: { ticker: string }) => s.ticker).join(', ')}?`
                  : 'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        const allActions = await queries.getCorporateActions(db, company.id, 'dividend');

        if (allActions.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `No dividend records found for ${normalized}. This company may not pay dividends, or data has not been ingested yet.`,
                data: { ticker: normalized, dividends: [] },
                context: { ticker: normalized },
                relatedTools: ['get_company_profile', 'get_income_statement'],
              }),
            }],
          };
        }

        const dividends = allActions.map((r: Record<string, unknown>) => ({
          ex_date: r.ex_date,
          record_date: r.record_date,
          details: r.details,
          dividend_per_share: r.value,
        }));

        // Compute basic stats
        const values = dividends
          .map((d: { dividend_per_share: unknown }) => {
            const v = typeof d.dividend_per_share === 'number'
              ? d.dividend_per_share
              : parseFloat(String(d.dividend_per_share ?? 0));
            return isFinite(v) ? v : 0;
          })
          .filter((v: number) => v > 0);

        const totalDividends = values.reduce((a: number, b: number) => a + b, 0);
        const avgDividend = values.length > 0 ? totalDividends / values.length : 0;

        const result = {
          ticker: normalized,
          companyName: company.company_name,
          totalRecords: dividends.length,
          totalDividendsPaid: Math.round(totalDividends * 100) / 100,
          averageDividend: Math.round(avgDividend * 100) / 100,
          dividends,
        };

        await cacheSet(key, result, CA_TTL);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${company.company_name} (${normalized}) -- ${dividends.length} dividend(s) on record. Average: Rs ${Math.round(avgDividend * 100) / 100}/share.`,
              data: result,
              context: {
                ticker: normalized,
                units: { dividend_per_share: 'INR per share', totalDividendsPaid: 'INR cumulative sum' },
              },
              relatedTools: [
                'get_stock_splits_bonuses',
                'get_company_profile',
                'get_financial_ratios',
                'get_upcoming_events',
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_dividends',
              err instanceof Error ? err.message : 'Dividend lookup failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_stock_splits_bonuses
  // ------------------------------------------------------------------
  server.tool(
    'get_stock_splits_bonuses',
    'Get the history of stock splits, bonus issues, and rights issues for an Indian ' +
    'listed company. Shows action type, ratios, and ex-dates. Use this to understand ' +
    'historical share capital changes and adjust historical price comparisons. ' +
    'Example: get_stock_splits_bonuses({ ticker: "RELIANCE" })',
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol. .NS/.BO suffixes stripped automatically.'
      ),
    },
    async ({ ticker }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const key = cacheKey('splits-bonuses', normalized);
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Splits/bonuses for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['get_dividends', 'get_price_history'],
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
                'get_stock_splits_bonuses',
                `Company "${normalized}" not found.`,
                suggestions.length > 0
                  ? `Did you mean: ${suggestions.map((s: { ticker: string }) => s.ticker).join(', ')}?`
                  : 'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        // Fetch all non-dividend corporate actions
        const allActions = await queries.getCorporateActions(db, company.id);
        const filtered = allActions.filter(
          (r: Record<string, unknown>) =>
            r.action_type !== 'dividend'
        );

        if (filtered.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `No stock splits, bonuses, or rights issues found for ${normalized}.`,
                data: { ticker: normalized, actions: [] },
                context: { ticker: normalized },
                relatedTools: ['get_dividends', 'get_company_profile'],
              }),
            }],
          };
        }

        const actions = filtered.map((r: Record<string, unknown>) => ({
          action_type: r.action_type,
          ex_date: r.ex_date,
          record_date: r.record_date,
          details: r.details,
          ratio_or_value: r.value,
        }));

        // Group by type for summary
        const byType: Record<string, number> = {};
        for (const a of actions) {
          const t = String(a.action_type);
          byType[t] = (byType[t] || 0) + 1;
        }

        const result = {
          ticker: normalized,
          companyName: company.company_name,
          totalActions: actions.length,
          breakdown: byType,
          actions,
        };

        await cacheSet(key, result, CA_TTL);

        const breakdownStr = Object.entries(byType)
          .map(([type, count]) => `${count} ${type}(s)`)
          .join(', ');

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${company.company_name} (${normalized}) -- ${actions.length} capital action(s): ${breakdownStr}.`,
              data: result,
              context: {
                ticker: normalized,
                note: 'For splits, "value" is the new face value. For bonuses, "value" is the ratio (e.g., 1 means 1:1 bonus). For rights, "value" is the issue price.',
              },
              relatedTools: [
                'get_dividends',
                'get_price_history',
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
              'get_stock_splits_bonuses',
              err instanceof Error ? err.message : 'Splits/bonuses lookup failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_upcoming_events
  // ------------------------------------------------------------------
  server.tool(
    'get_upcoming_events',
    'Get upcoming corporate events across the market: ex-dividend dates, stock splits, ' +
    'bonus issues, rights issues, and buybacks. Filter by event type and time horizon. ' +
    'Use this to plan around corporate action dates or find upcoming dividend opportunities. ' +
    'Example: get_upcoming_events({ days: 30, actionType: "dividend" })',
    {
      days: z.number().min(1).max(365).optional().describe(
        'How far ahead to look in days (default 90)'
      ),
      actionType: z.enum(['dividend', 'split', 'bonus', 'rights', 'buyback']).optional().describe(
        'Filter by specific action type. Omit for all types.'
      ),
    },
    async ({ days, actionType }) => {
      try {
        const d = days ?? 90;
        const key = cacheKey('upcoming-events', actionType ?? 'all', { days: d });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Upcoming events (cached)`,
                data: cached,
                context: {},
                relatedTools: ['get_dividends', 'get_stock_splits_bonuses'],
              }),
            }],
          };
        }

        const events = await queries.getUpcomingCorporateActions(db, {
          days: d,
          actionType,
        });

        // Group by type for summary
        const byType: Record<string, number> = {};
        for (const e of events) {
          const t = String((e as Record<string, unknown>).action_type);
          byType[t] = (byType[t] || 0) + 1;
        }

        const result = {
          period: `Next ${d} days`,
          filterType: actionType ?? 'all',
          totalEvents: events.length,
          breakdown: byType,
          events,
        };

        if (events.length > 0) {
          await cacheSet(key, result, TTL.LATEST_PRICE); // short TTL, new events can appear
        }

        const breakdownStr = Object.entries(byType)
          .map(([type, count]) => `${count} ${type}(s)`)
          .join(', ');

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: events.length > 0
                ? `${events.length} upcoming event(s) in next ${d} days: ${breakdownStr}.`
                : `No upcoming ${actionType ?? 'corporate'} events found in the next ${d} days.`,
              data: result,
              context: {
                note: 'Events are sorted by ex_date ascending (soonest first). Dates are subject to change by the company.',
              },
              relatedTools: [
                'get_dividends',
                'get_stock_splits_bonuses',
                'search_companies',
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_upcoming_events',
              err instanceof Error ? err.message : 'Upcoming events lookup failed'
            ),
          }],
        };
      }
    }
  );
}
