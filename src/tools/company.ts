/**
 * Company tools — search, profile, peers, index, sector.
 *
 * THIS IS THE REFERENCE IMPLEMENTATION for how all tool modules should work.
 * Cowork: follow this exact pattern for every other tool domain.
 *
 * Every tool module exports a single registerTools() function that:
 * 1. Registers tools with the MCP server using server.tool()
 * 2. Uses Zod schemas for input validation
 * 3. Queries via src/db/queries.ts (never raw SQL)
 * 4. Caches results via src/cache/redis.ts
 * 5. Returns AI-native formatted responses via response-builder
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

export function registerTools(
  server: McpServer,
  db: Pool,
  _cache: RedisClient
): void {

  // ------------------------------------------------------------------
  // search_companies
  // ------------------------------------------------------------------
  server.tool(
    'search_companies',
    'Search for Indian listed companies by name, ticker symbol, or ISIN. ' +
    'Supports fuzzy matching on company names. Optionally filter by sector ' +
    'and market cap range. Returns up to 10 results by default. ' +
    'Example: search_companies({ query: "reliance" }) or ' +
    'search_companies({ query: "IT", sector: "Information Technology", marketCapMin: 10000 })',
    {
      query: z.string().min(1).describe(
        'Search term: company name (partial OK), ticker symbol, or ISIN code'
      ),
      limit: z.number().min(1).max(50).optional().describe(
        'Max results to return (default 10)'
      ),
      sector: z.string().optional().describe(
        'Filter by sector name, e.g. "Information Technology", "Financial Services"'
      ),
      marketCapMin: z.number().optional().describe(
        'Minimum market cap in crores'
      ),
      marketCapMax: z.number().optional().describe(
        'Maximum market cap in crores'
      ),
    },
    async ({ query, limit, sector, marketCapMin, marketCapMax }) => {
      try {
        const key = cacheKey('search', query, { limit, sector, marketCapMin, marketCapMax });
        const cached = await cacheGet<unknown[]>(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Found ${cached.length} companies matching "${query}" (cached)`,
                data: cached,
                context: { count: cached.length },
                relatedTools: ['get_company_profile', 'get_financial_ratios', 'compare_financials'],
              }),
            }],
          };
        }

        const results = await queries.searchCompanies(db, query, {
          limit,
          sector,
          marketCapMin,
          marketCapMax,
        });

        if (results.length > 0) {
          await cacheSet(key, results, TTL.SEARCH_RESULTS);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: results.length > 0
                ? `Found ${results.length} companies matching "${query}"`
                : `No companies found matching "${query}". Try a broader search term.`,
              data: results,
              context: { count: results.length },
              relatedTools: ['get_company_profile', 'get_financial_ratios', 'run_screen'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'search_companies',
              err instanceof Error ? err.message : 'Search failed',
              'Try a simpler search term or check that the database is populated.'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_company_profile
  // ------------------------------------------------------------------
  server.tool(
    'get_company_profile',
    'Get the full profile of an Indian listed company including sector, industry, ' +
    'market cap, listing date, and key current metrics (PE, PB, dividend yield). ' +
    'Accepts BSE/NSE ticker symbols. Strips .NS/.BO suffixes automatically. ' +
    'Example: get_company_profile({ ticker: "TCS" })',
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol, e.g. "RELIANCE", "TCS", "HDFCBANK". ' +
        '.NS and .BO suffixes are stripped automatically.'
      ),
    },
    async ({ ticker }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const key = cacheKey('profile', normalized);
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Profile for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: [
                  'get_income_statement',
                  'get_financial_ratios',
                  'get_company_peers',
                  'explain_company',
                ],
              }),
            }],
          };
        }

        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          // Try fuzzy search as fallback
          const suggestions = await queries.searchCompanies(db, normalized, { limit: 3 });
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'get_company_profile',
                `Company "${normalized}" not found.`,
                suggestions.length > 0
                  ? `Did you mean: ${suggestions.map((s: { ticker: string }) => s.ticker).join(', ')}?`
                  : 'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        // Enrich with latest ratios
        const ratios = await queries.getRatios(db, company.id, 1);
        const latestPrice = await queries.getLatestPrice(db, company.id);

        const profile = {
          ...company,
          latestPrice: latestPrice?.close_price || null,
          latestPriceDate: latestPrice?.trade_date || null,
          latestRatios: ratios[0] || null,
        };

        await cacheSet(key, profile, TTL.COMPANY_PROFILE);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${company.company_name} (${normalized}) — ${company.sector}, Market Cap ₹${company.market_cap_cr} Cr`,
              data: profile,
              context: {
                ticker: normalized,
                sector: company.sector,
                units: { market_cap_cr: 'INR Crores', ratios: 'Decimals (0.15 = 15%)' },
              },
              relatedTools: [
                'get_income_statement',
                'get_balance_sheet',
                'get_financial_ratios',
                'get_company_peers',
                'get_price_history',
                'explain_company',
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'get_company_profile',
              err instanceof Error ? err.message : 'Profile lookup failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_company_peers
  // ------------------------------------------------------------------
  server.tool(
    'get_company_peers',
    'Get peer companies in the same industry, ranked by market cap proximity. ' +
    'Useful for relative valuation and competitive analysis. ' +
    'Example: get_company_peers({ ticker: "INFY", limit: 5 })',
    {
      ticker: z.string().min(1).describe('Company ticker symbol'),
      limit: z.number().min(1).max(20).optional().describe('Number of peers (default 10)'),
    },
    async ({ ticker, limit }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const company = await queries.getCompanyByTicker(db, normalized);
        if (!company) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse('get_company_peers', `Company "${normalized}" not found.`),
            }],
          };
        }

        const peers = await queries.getCompanyPeers(db, company.id, limit || 10);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${peers.length} peers for ${normalized} in ${company.industry}`,
              data: { company: normalized, industry: company.industry, peers },
              context: { ticker: normalized, sector: company.sector, count: peers.length },
              relatedTools: ['compare_financials', 'get_valuation_metrics'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse('get_company_peers', err instanceof Error ? err.message : 'Peer lookup failed'),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_index_constituents
  // ------------------------------------------------------------------
  server.tool(
    'get_index_constituents',
    'List all companies in a given stock market index with their weights. ' +
    'Supported indices: NIFTY 50, NIFTY NEXT 50, NIFTY 100, NIFTY BANK, ' +
    'NIFTY IT, NIFTY PHARMA, NIFTY FMCG, NIFTY AUTO, and more. ' +
    'Example: get_index_constituents({ index: "NIFTY 50" })',
    {
      index: z.string().min(1).describe(
        'Index name, e.g. "NIFTY 50", "NIFTY BANK", "NIFTY IT"'
      ),
    },
    async ({ index }) => {
      try {
        const key = cacheKey('index', index);
        const cached = await cacheGet<unknown[]>(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `${cached.length} companies in ${index} (cached)`,
                data: cached,
                context: { count: cached.length },
                relatedTools: ['get_sector_overview', 'get_market_overview'],
              }),
            }],
          };
        }

        const constituents = await queries.getIndexConstituents(db, index.toUpperCase());

        if (constituents.length > 0) {
          await cacheSet(key, constituents, TTL.INDEX_CONSTITUENTS);
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: constituents.length > 0
                ? `${constituents.length} companies in ${index}`
                : `No data found for index "${index}". Check the index name.`,
              data: constituents,
              context: { count: constituents.length },
              relatedTools: ['get_sector_overview', 'compare_financials'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse('get_index_constituents', err instanceof Error ? err.message : 'Index lookup failed'),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // get_sector_overview
  // ------------------------------------------------------------------
  server.tool(
    'get_sector_overview',
    'Get aggregate statistics for an entire sector: company count, total market cap, ' +
    'average PE/PB/ROE, and lists of top gainers, losers, and largest companies. ' +
    'Example: get_sector_overview({ sector: "Information Technology" })',
    {
      sector: z.string().min(1).describe(
        'Sector name, e.g. "Information Technology", "Financial Services", "Healthcare"'
      ),
    },
    async ({ sector }) => {
      try {
        const { rows } = await db.query(
          `SELECT
            COUNT(*) as company_count,
            SUM(market_cap_cr) as total_market_cap,
            AVG(market_cap_cr) as avg_market_cap
          FROM companies
          WHERE sector = $1 AND is_active = TRUE`,
          [sector]
        );

        const stats = rows[0];

        // Top companies by market cap
        const { rows: topCompanies } = await db.query(
          `SELECT ticker, company_name, market_cap_cr, industry
           FROM companies
           WHERE sector = $1 AND is_active = TRUE
           ORDER BY market_cap_cr DESC NULLS LAST
           LIMIT 10`,
          [sector]
        );

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${sector}: ${stats.company_count} companies, total market cap ₹${Math.round(stats.total_market_cap)} Cr`,
              data: {
                sector,
                companyCount: parseInt(stats.company_count, 10),
                totalMarketCapCr: Math.round(parseFloat(stats.total_market_cap)),
                avgMarketCapCr: Math.round(parseFloat(stats.avg_market_cap)),
                largestCompanies: topCompanies,
              },
              context: {
                sector,
                units: { market_cap: 'INR Crores' },
              },
              relatedTools: ['run_screen', 'get_sector_rotation', 'compare_financials'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse('get_sector_overview', err instanceof Error ? err.message : 'Sector overview failed'),
          }],
        };
      }
    }
  );
}
