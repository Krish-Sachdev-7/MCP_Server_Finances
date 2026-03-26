/**
 * AI-native tools -- ask_about_data, explain_company, compare_investment_thesis,
 * generate_research_report.
 *
 * Phase 3 implementation -- follows the exact pattern from src/tools/company.ts.
 *
 * These tools are fundamentally different from the rest: they pull from MULTIPLE
 * tables, cross-reference data, and assemble structured narratives optimized for
 * an LLM to relay to a human user.
 *
 * RISK 3 compliance: ask_about_data handles fuzzy NL queries.
 * Its description explicitly routes structured numeric queries to run_screen.
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
import { cagr, dcfValuation, grahamNumber, sma, ema, rsi, macd } from '../utils/financial-math.js';

// ============================================================
// HELPERS
// ============================================================

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isFinite(n) ? n : 0;
}

function toNumOrNull(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isFinite(n) ? n : null;
}

function roundTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function marketCapTier(mcap: number): string {
  if (mcap > 100000) return 'mega';
  if (mcap > 20000) return 'large';
  if (mcap > 5000) return 'mid';
  if (mcap > 1000) return 'small';
  return 'micro';
}

// ============================================================
// COMPANY DATA BUNDLE -- shared fetcher for all 3 narrative tools
// ============================================================

interface CompanyDataBundle {
  company: Record<string, unknown>;
  ratios: Record<string, unknown>[];       // latest 5 years
  annuals: Record<string, unknown>[];      // latest 5 years
  quarterlies: Record<string, unknown>[];  // latest 8 quarters
  latestPrice: Record<string, unknown> | null;
  prices365: Record<string, unknown>[];    // 1 year price history
  shareholding: Record<string, unknown>[]; // latest 4 quarters
  insiderTrades: Record<string, unknown>[];
}

async function fetchCompanyDataBundle(
  db: Pool,
  companyId: number
): Promise<CompanyDataBundle> {
  const [ratios, annuals, quarterlies, latestPrice, prices365, shareholding, insiderTrades] =
    await Promise.all([
      queries.getRatios(db, companyId, 5),
      queries.getAnnualFinancials(db, companyId, 5),
      queries.getQuarterlyFinancials(db, companyId, 8),
      queries.getLatestPrice(db, companyId),
      queries.getPriceHistory(db, companyId, 365),
      queries.getShareholdingPattern(db, companyId, 4),
      queries.getInsiderTrades(db, { companyId, days: 90 }),
    ]);

  return {
    company: {}, // filled by caller after lookup
    ratios: ratios as Record<string, unknown>[],
    annuals: annuals as Record<string, unknown>[],
    quarterlies: quarterlies as Record<string, unknown>[],
    latestPrice: latestPrice as Record<string, unknown> | null,
    prices365: prices365 as Record<string, unknown>[],
    shareholding: shareholding as Record<string, unknown>[],
    insiderTrades: insiderTrades as Record<string, unknown>[],
  };
}

/** Derive financial health strengths and concerns from data. */
function deriveFinancialHealth(
  r: Record<string, unknown> | undefined,
  annuals: Record<string, unknown>[],
  sh: Record<string, unknown> | undefined
): { strengths: string[]; concerns: string[] } {
  const strengths: string[] = [];
  const concerns: string[] = [];
  if (!r) return { strengths, concerns };

  const roe = toNum(r.roe);
  const roce = toNum(r.roce);
  const dte = toNum(r.debt_to_equity);
  const opMargin = toNum(r.operating_margin);
  const curRatio = toNum(r.current_ratio);
  const fcf = toNum(r.fcf);
  const revGrowth3y = toNum(r.revenue_cagr_3y);
  const profGrowth3y = toNum(r.profit_cagr_3y);
  const pledged = sh ? toNum(sh.pledged_percentage) : 0;

  if (roe > 0.15) strengths.push(`Strong ROE of ${roundTo(roe * 100, 1)}%`);
  if (roce > 0.15) strengths.push(`Strong ROCE of ${roundTo(roce * 100, 1)}%`);
  if (dte < 0.5 && dte >= 0) strengths.push(`Low debt (D/E: ${roundTo(dte, 2)})`);
  if (revGrowth3y > 0) strengths.push(`Positive 3Y revenue CAGR (${roundTo(revGrowth3y * 100, 1)}%)`);
  if (profGrowth3y > 0) strengths.push(`Positive 3Y profit CAGR (${roundTo(profGrowth3y * 100, 1)}%)`);
  if (opMargin > 0.15) strengths.push(`Healthy operating margin (${roundTo(opMargin * 100, 1)}%)`);
  if (curRatio > 1.5) strengths.push(`Strong current ratio (${roundTo(curRatio, 2)})`);
  if (fcf > 0) strengths.push('Positive free cash flow');

  if (roe > 0 && roe < 0.10) concerns.push(`Low ROE (${roundTo(roe * 100, 1)}%)`);
  if (roce > 0 && roce < 0.10) concerns.push(`Low ROCE (${roundTo(roce * 100, 1)}%)`);
  if (dte > 1.5) concerns.push(`High debt (D/E: ${roundTo(dte, 2)})`);
  if (revGrowth3y < 0) concerns.push(`Negative 3Y revenue growth (${roundTo(revGrowth3y * 100, 1)}%)`);
  if (profGrowth3y < 0) concerns.push(`Negative 3Y profit growth (${roundTo(profGrowth3y * 100, 1)}%)`);
  if (fcf < 0) concerns.push('Negative free cash flow');
  if (pledged > 10) concerns.push(`Pledged shares: ${roundTo(pledged, 1)}%`);

  // Margin decline check
  if (annuals.length >= 3) {
    const margins = annuals.map(a => toNum(a.operating_profit) / Math.max(toNum(a.revenue), 1));
    const avgMargin = margins.reduce((s, m) => s + m, 0) / margins.length;
    if (margins[0] < avgMargin * 0.9) concerns.push('Declining operating margins vs 3Y average');
  }

  return { strengths, concerns };
}

/** Compute price returns from price history. */
function computePriceReturns(
  prices: Record<string, unknown>[],
  daysBack: number
): number | null {
  if (prices.length < 2) return null;
  const latest = prices[prices.length - 1];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  let earliest: Record<string, unknown> | null = null;
  for (const p of prices) {
    const d = new Date(String(p.trade_date));
    if (d >= cutoff) { earliest = p; break; }
  }
  if (!earliest) earliest = prices[0];
  const latClose = toNum(latest.close_price);
  const earClose = toNum(earliest.close_price);
  if (earClose <= 0) return null;
  return roundTo(((latClose - earClose) / earClose) * 100, 2);
}

// ============================================================
// QUERY PATTERN ENGINE for ask_about_data
// ============================================================

interface QueryPattern {
  id: string;
  match: (question: string) => boolean;
  buildQuery: (question: string, db: Pool) => Promise<{ sql: string; params: unknown[]; description: string }>;
  formatSummary: (rows: Record<string, unknown>[], description: string) => string;
}

function extractSector(q: string): string | null {
  const sectorMap: Record<string, string> = {
    'it': 'Information Technology', 'tech': 'Information Technology',
    'technology': 'Information Technology', 'software': 'Information Technology',
    'bank': 'Financial Services', 'banking': 'Financial Services',
    'finance': 'Financial Services', 'financial': 'Financial Services',
    'nbfc': 'Financial Services',
    'pharma': 'Healthcare', 'healthcare': 'Healthcare',
    'health': 'Healthcare', 'pharmaceutical': 'Healthcare',
    'auto': 'Automobile', 'automobile': 'Automobile', 'automotive': 'Automobile',
    'fmcg': 'FMCG', 'consumer': 'Consumer Durables',
    'energy': 'Energy', 'oil': 'Energy',
    'metal': 'Metals & Mining', 'metals': 'Metals & Mining',
    'mining': 'Metals & Mining', 'steel': 'Metals & Mining',
    'cement': 'Construction Materials', 'construction': 'Construction',
    'infra': 'Infrastructure', 'infrastructure': 'Infrastructure',
    'telecom': 'Telecommunication',
    'utility': 'Utilities', 'utilities': 'Utilities', 'power': 'Utilities',
    'real estate': 'Real Estate', 'realty': 'Real Estate',
    'chemical': 'Chemicals', 'chemicals': 'Chemicals',
    'defence': 'Defence', 'defense': 'Defence',
    'media': 'Media & Entertainment', 'retail': 'Retail',
  };
  const lower = q.toLowerCase();
  for (const [keyword, sector] of Object.entries(sectorMap)) {
    if (lower.includes(keyword)) return sector;
  }
  return null;
}

function extractTopN(q: string): number {
  const match = q.match(/\btop\s+(\d+)\b/i);
  return match ? Math.min(parseInt(match[1], 10), 50) : 10;
}

function buildPatterns(): QueryPattern[] {
  return [
    {
      id: 'highest_metric',
      match: (q) => /\b(highest|top|best|most|largest|biggest)\b.*\b(roe|roce|margin|growth|pe|pb|market cap|dividend|yield)/i.test(q),
      buildQuery: async (q) => {
        const metricMap: Record<string, { col: string; label: string }> = {
          'roe': { col: 'r.roe', label: 'ROE' }, 'roce': { col: 'r.roce', label: 'ROCE' },
          'margin': { col: 'r.operating_margin', label: 'operating margin' },
          'growth': { col: 'r.revenue_growth_yoy', label: 'revenue growth' },
          'dividend': { col: 'r.dividend_yield', label: 'dividend yield' },
          'yield': { col: 'r.dividend_yield', label: 'dividend yield' },
          'market cap': { col: 'c.market_cap_cr', label: 'market cap' },
          'pe': { col: 'r.pe_ratio', label: 'PE ratio' },
          'pb': { col: 'r.pb_ratio', label: 'PB ratio' },
        };
        const lower = q.toLowerCase();
        let metric = metricMap['roe'];
        for (const [key, val] of Object.entries(metricMap)) { if (lower.includes(key)) { metric = val; break; } }
        const sector = extractSector(q); const n = extractTopN(q);
        const sectorClause = sector ? `AND c.sector = $1` : '';
        const params: unknown[] = sector ? [sector, n] : [n];
        const limitParam = sector ? '$2' : '$1';
        return {
          sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, ${metric.col} as metric_value FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) ${sectorClause} ORDER BY ${metric.col} DESC NULLS LAST LIMIT ${limitParam}`,
          params, description: `Top ${n} companies by ${metric.label}${sector ? ` in ${sector}` : ''}`,
        };
      },
      formatSummary: (rows, desc) => `${desc}: found ${rows.length} companies`,
    },
    {
      id: 'lowest_metric',
      match: (q) => /\b(lowest|cheapest|least|smallest|minimum)\b.*\b(debt|pe|pb|leverage)/i.test(q),
      buildQuery: async (q) => {
        const lower = q.toLowerCase();
        let col = 'r.debt_to_equity'; let label = 'debt-to-equity';
        if (lower.includes('pe')) { col = 'r.pe_ratio'; label = 'PE ratio'; }
        else if (lower.includes('pb')) { col = 'r.pb_ratio'; label = 'PB ratio'; }
        const sector = extractSector(q); const n = extractTopN(q);
        const sectorClause = sector ? `AND c.sector = $1` : '';
        const params: unknown[] = sector ? [sector, n] : [n];
        const limitParam = sector ? '$2' : '$1';
        return {
          sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, ${col} as metric_value FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) AND ${col} >= 0 ${sectorClause} ORDER BY ${col} ASC NULLS LAST LIMIT ${limitParam}`,
          params, description: `Top ${n} companies by lowest ${label}${sector ? ` in ${sector}` : ''}`,
        };
      },
      formatSummary: (rows, desc) => `${desc}: found ${rows.length} companies`,
    },
    {
      id: 'count_companies',
      match: (q) => /\bhow many\b/i.test(q),
      buildQuery: async (q) => {
        const lower = q.toLowerCase(); const sector = extractSector(q);
        const conditions: string[] = ['c.is_active = TRUE']; const params: unknown[] = [];
        let paramIdx = 1;
        if (sector) { conditions.push(`c.sector = $${paramIdx}`); params.push(sector); paramIdx++; }
        if (lower.includes('zero debt') || lower.includes('no debt') || lower.includes('debt free') || lower.includes('debt-free')) conditions.push(`r.debt_to_equity < 0.05`);
        if (lower.includes('profit') && lower.includes('loss')) conditions.push(`r.net_margin < 0`);
        if (lower.includes('profitable')) conditions.push(`r.net_margin > 0`);
        const needsRatios = lower.includes('debt') || lower.includes('profit') || lower.includes('margin');
        return {
          sql: needsRatios
            ? `SELECT COUNT(DISTINCT c.id) as count FROM companies c JOIN ratios r ON c.id = r.company_id WHERE ${conditions.join(' AND ')} AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id)`
            : `SELECT COUNT(*) as count FROM companies c WHERE ${conditions.join(' AND ')}`,
          params, description: `Count of companies matching the criteria`,
        };
      },
      formatSummary: (rows) => { const count = rows[0]?.count ?? 0; return `Found ${count} companies matching the criteria`; },
    },
    {
      id: 'sector_list',
      match: (q) => /\b(companies|stocks|list)\b.*\b(in|from|of)\b.*\b(sector|industry)/i.test(q) || (/\b(companies|stocks)\b/i.test(q) && extractSector(q) !== null),
      buildQuery: async (q) => {
        const sector = extractSector(q); const n = extractTopN(q);
        if (!sector) return { sql: `SELECT DISTINCT sector, COUNT(*) as count FROM companies WHERE is_active = TRUE GROUP BY sector ORDER BY count DESC`, params: [], description: 'All sectors with company counts' };
        return { sql: `SELECT c.ticker, c.company_name, c.industry, c.market_cap_cr FROM companies c WHERE c.is_active = TRUE AND c.sector = $1 ORDER BY c.market_cap_cr DESC NULLS LAST LIMIT $2`, params: [sector, n], description: `Companies in the ${sector} sector` };
      },
      formatSummary: (rows, desc) => `${desc}: ${rows.length} results`,
    },
    {
      id: 'sector_average',
      match: (q) => /\b(average|avg|mean|median)\b/i.test(q),
      buildQuery: async (q) => {
        const lower = q.toLowerCase(); const sector = extractSector(q);
        let col = 'r.pe_ratio'; let label = 'PE ratio';
        if (lower.includes('roe')) { col = 'r.roe'; label = 'ROE'; }
        else if (lower.includes('roce')) { col = 'r.roce'; label = 'ROCE'; }
        else if (lower.includes('pb')) { col = 'r.pb_ratio'; label = 'PB ratio'; }
        else if (lower.includes('margin')) { col = 'r.operating_margin'; label = 'operating margin'; }
        else if (lower.includes('debt')) { col = 'r.debt_to_equity'; label = 'debt-to-equity'; }
        else if (lower.includes('growth')) { col = 'r.revenue_growth_yoy'; label = 'revenue growth'; }
        else if (lower.includes('dividend')) { col = 'r.dividend_yield'; label = 'dividend yield'; }
        const sectorClause = sector ? `AND c.sector = $1` : '';
        return { sql: `SELECT AVG(${col}) as avg_value, MIN(${col}) as min_value, MAX(${col}) as max_value, COUNT(*) as company_count FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) ${sectorClause}`, params: sector ? [sector] : [], description: `Average ${label}${sector ? ` of ${sector} companies` : ' across all companies'}` };
      },
      formatSummary: (rows, desc) => { const r = rows[0]; if (!r) return desc; const avg = r.avg_value !== null ? Number(r.avg_value).toFixed(4) : 'N/A'; return `${desc}: avg ${avg} (min ${Number(r.min_value ?? 0).toFixed(4)}, max ${Number(r.max_value ?? 0).toFixed(4)}) across ${r.company_count} companies`; },
    },
    {
      id: 'valuation_nlp',
      match: (q) => /\b(undervalued|overvalued|cheap|expensive|bargain)\b/i.test(q),
      buildQuery: async (q) => {
        const lower = q.toLowerCase(); const sector = extractSector(q); const n = extractTopN(q);
        const isUnder = lower.includes('undervalued') || lower.includes('cheap') || lower.includes('bargain');
        const sectorClause = sector ? `AND c.sector = $1` : '';
        const params: unknown[] = sector ? [sector, n] : [n];
        const lp = sector ? '$2' : '$1';
        if (isUnder) return { sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, r.pe_ratio, r.pb_ratio, r.roe, r.roce FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) AND r.pe_ratio > 0 AND r.pe_ratio < 15 AND r.roe > 0.12 ${sectorClause} ORDER BY r.pe_ratio ASC LIMIT ${lp}`, params, description: `Potentially undervalued stocks (low PE + decent ROE)${sector ? ` in ${sector}` : ''}` };
        return { sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, r.pe_ratio, r.pb_ratio, r.roe FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) AND r.pe_ratio > 50 ${sectorClause} ORDER BY r.pe_ratio DESC LIMIT ${lp}`, params, description: `Potentially overvalued stocks (high PE)${sector ? ` in ${sector}` : ''}` };
      },
      formatSummary: (rows, desc) => `${desc}: found ${rows.length} companies`,
    },
    {
      id: 'dividend_stocks',
      match: (q) => /\bdividend/i.test(q),
      buildQuery: async (q) => {
        const sector = extractSector(q); const n = extractTopN(q);
        const sc = sector ? `AND c.sector = $1` : ''; const params: unknown[] = sector ? [sector, n] : [n]; const lp = sector ? '$2' : '$1';
        return { sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, r.dividend_yield, r.pe_ratio, r.debt_to_equity FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) AND r.dividend_yield > 0.01 ${sc} ORDER BY r.dividend_yield DESC NULLS LAST LIMIT ${lp}`, params, description: `Highest dividend yield stocks${sector ? ` in ${sector}` : ''}` };
      },
      formatSummary: (rows, desc) => `${desc}: found ${rows.length} companies`,
    },
    {
      id: 'debt_free',
      match: (q) => /\b(debt.?free|zero debt|no debt)\b/i.test(q),
      buildQuery: async (q) => {
        const sector = extractSector(q); const n = extractTopN(q);
        const sc = sector ? `AND c.sector = $1` : ''; const params: unknown[] = sector ? [sector, n] : [n]; const lp = sector ? '$2' : '$1';
        return { sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, r.roe, r.roce, r.debt_to_equity FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) AND r.debt_to_equity < 0.05 ${sc} ORDER BY r.roe DESC NULLS LAST LIMIT ${lp}`, params, description: `Debt-free companies${sector ? ` in ${sector}` : ''}` };
      },
      formatSummary: (rows, desc) => `${desc}: found ${rows.length} companies`,
    },
    {
      id: 'growth_stocks',
      match: (q) => /\b(growing|growth|fast.?grow|growers)\b/i.test(q) && !/\baverage\b/i.test(q),
      buildQuery: async (q) => {
        const sector = extractSector(q); const n = extractTopN(q);
        const sc = sector ? `AND c.sector = $1` : ''; const params: unknown[] = sector ? [sector, n] : [n]; const lp = sector ? '$2' : '$1';
        return { sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, r.revenue_growth_yoy, r.profit_growth_yoy, r.roe FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) AND r.revenue_growth_yoy > 0.15 ${sc} ORDER BY r.revenue_growth_yoy DESC NULLS LAST LIMIT ${lp}`, params, description: `Fastest growing companies${sector ? ` in ${sector}` : ''}` };
      },
      formatSummary: (rows, desc) => `${desc}: found ${rows.length} companies`,
    },
    {
      id: 'profitable',
      match: (q) => /\bprofitabl/i.test(q),
      buildQuery: async (q) => {
        const sector = extractSector(q); const n = extractTopN(q);
        const sc = sector ? `AND c.sector = $1` : ''; const params: unknown[] = sector ? [sector, n] : [n]; const lp = sector ? '$2' : '$1';
        return { sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, r.net_margin, r.operating_margin, r.roe, r.roce FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) AND r.net_margin > 0 ${sc} ORDER BY r.net_margin DESC NULLS LAST LIMIT ${lp}`, params, description: `Most profitable companies${sector ? ` in ${sector}` : ''}` };
      },
      formatSummary: (rows, desc) => `${desc}: found ${rows.length} companies`,
    },
    {
      id: 'cap_category',
      match: (q) => /\b(large.?cap|mid.?cap|small.?cap|micro.?cap)\b/i.test(q),
      buildQuery: async (q) => {
        const lower = q.toLowerCase();
        let minCap = 0; let maxCap = 999999999; let label = 'companies';
        if (lower.includes('large')) { minCap = 50000; label = 'Large-cap'; }
        else if (lower.includes('mid')) { minCap = 10000; maxCap = 50000; label = 'Mid-cap'; }
        else if (lower.includes('small')) { minCap = 1000; maxCap = 10000; label = 'Small-cap'; }
        else if (lower.includes('micro')) { maxCap = 1000; label = 'Micro-cap'; }
        const sector = extractSector(q); const n = extractTopN(q);
        const conditions = ['c.is_active = TRUE', `c.market_cap_cr >= $1`, `c.market_cap_cr <= $2`];
        const params: unknown[] = [minCap, maxCap]; let paramIdx = 3;
        if (sector) { conditions.push(`c.sector = $${paramIdx}`); params.push(sector); paramIdx++; }
        params.push(n);
        return { sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr FROM companies c WHERE ${conditions.join(' AND ')} ORDER BY c.market_cap_cr DESC NULLS LAST LIMIT $${paramIdx}`, params, description: `${label} stocks${sector ? ` in ${sector}` : ''}` };
      },
      formatSummary: (rows, desc) => `${desc}: found ${rows.length} companies`,
    },
    {
      id: 'compare_companies',
      match: (q) => /\b(compare|versus|vs\.?)\b/i.test(q) || /\band\b.*\bvs\b/i.test(q),
      buildQuery: async (q) => {
        const words = q.split(/[\s,]+/);
        const tickers = words.filter((w) => /^[A-Z]{2,}$/.test(w) || /^[A-Z][\w&-]+$/.test(w.toUpperCase())).map((w) => w.toUpperCase().replace(/\.NS$|\.BO$/, '')).filter((w) => !['AND', 'OR', 'THE', 'FOR', 'HOW', 'WHAT', 'WHICH', 'COMPARE', 'VERSUS'].includes(w));
        if (tickers.length < 2) return { sql: `SELECT 1 as hint`, params: [], description: 'Could not identify two tickers to compare. Please specify tickers like "compare TCS and INFY".' };
        return { sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, r.pe_ratio, r.pb_ratio, r.roe, r.roce, r.debt_to_equity, r.operating_margin, r.net_margin, r.revenue_growth_yoy, r.profit_growth_yoy, r.dividend_yield, r.piotroski_score FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND c.ticker IN ($1, $2) AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id)`, params: [tickers[0], tickers[1]], description: `Comparison of ${tickers[0]} and ${tickers[1]}` };
      },
      formatSummary: (rows, desc) => `${desc}: ${rows.length} companies found`,
    },
    {
      id: 'sector_ranking',
      match: (q) => /\bsector/i.test(q) && /\b(best|worst|ranking|rank|performance|return)\b/i.test(q),
      buildQuery: async () => ({ sql: `SELECT c.sector, COUNT(*) as company_count, ROUND(AVG(r.roe)::numeric, 4) as avg_roe, ROUND(AVG(r.roce)::numeric, 4) as avg_roce, ROUND(AVG(r.revenue_growth_yoy)::numeric, 4) as avg_revenue_growth, ROUND(SUM(c.market_cap_cr)::numeric, 0) as total_market_cap FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) GROUP BY c.sector ORDER BY avg_roe DESC NULLS LAST`, params: [], description: 'Sector ranking by average ROE' }),
      formatSummary: (rows, desc) => `${desc}: ${rows.length} sectors analyzed`,
    },
    {
      id: 'single_company',
      match: (q) => { const words = q.split(/[\s,]+/); return words.some((w) => /^[A-Z]{2,}$/.test(w) && !['AND', 'OR', 'THE', 'FOR', 'HOW', 'WHAT', 'WHICH'].includes(w)); },
      buildQuery: async (q) => {
        const words = q.split(/[\s,]+/);
        const ticker = words.find((w) => /^[A-Z]{2,}$/.test(w) && !['AND', 'OR', 'THE', 'FOR', 'HOW', 'WHAT', 'WHICH'].includes(w));
        if (!ticker) return { sql: 'SELECT 1 as hint', params: [], description: 'Could not identify a ticker symbol.' };
        return { sql: `SELECT c.ticker, c.company_name, c.sector, c.industry, c.market_cap_cr, r.pe_ratio, r.pb_ratio, r.roe, r.roce, r.debt_to_equity, r.operating_margin, r.net_margin, r.revenue_growth_yoy, r.profit_growth_yoy, r.dividend_yield, r.piotroski_score, r.earnings_yield, r.fcf_yield FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.ticker = $1 AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id)`, params: [ticker], description: `Data for ${ticker}` };
      },
      formatSummary: (rows, desc) => rows.length > 0 ? `${desc}: found` : `${desc}: not found`,
    },
    {
      id: 'general_fallback',
      match: () => true,
      buildQuery: async (q) => {
        const sector = extractSector(q); const n = extractTopN(q);
        const sc = sector ? `AND c.sector = $1` : ''; const params: unknown[] = sector ? [sector, n] : [n]; const lp = sector ? '$2' : '$1';
        return { sql: `SELECT c.ticker, c.company_name, c.sector, c.market_cap_cr, r.pe_ratio, r.roe, r.roce, r.debt_to_equity, r.revenue_growth_yoy FROM companies c JOIN ratios r ON c.id = r.company_id WHERE c.is_active = TRUE AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id) ${sc} ORDER BY c.market_cap_cr DESC NULLS LAST LIMIT ${lp}`, params, description: `General query results${sector ? ` for ${sector}` : ''}` };
      },
      formatSummary: (rows, desc) => `${desc}: ${rows.length} results`,
    },
  ];
}

// ============================================================
// REGISTER TOOLS
// ============================================================

export function registerTools(
  server: McpServer,
  db: Pool,
  _cache: RedisClient
): void {

  const patterns = buildPatterns();

  // ------------------------------------------------------------------
  // ask_about_data
  // ------------------------------------------------------------------
  server.tool(
    'ask_about_data',
    'Answer natural language questions about the equity database by translating them ' +
    'to SQL. Use this for exploratory questions in plain English like "which IT ' +
    'companies have the highest ROE" or "how many companies have zero debt" or ' +
    '"compare TCS and INFY" or "average PE of banking stocks". Handles fuzzy, ' +
    'conversational queries about sectors, rankings, counts, averages, and company ' +
    'comparisons. For precise numeric screening with explicit operators like ' +
    '"ROCE > 20 AND PE < 15", use run_screen instead. ' +
    'Example: ask_about_data({ question: "which pharma companies have low debt and high growth" })',
    {
      question: z.string().min(3).describe(
        'Natural language question about Indian equity data'
      ),
    },
    async ({ question }) => {
      try {
        const key = cacheKey('ask-data', question.toLowerCase().trim().slice(0, 100));
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Answer (cached)`,
                data: cached,
                context: {},
                relatedTools: ['run_screen', 'get_company_profile', 'get_valuation_metrics'],
              }),
            }],
          };
        }

        let matchedPattern: QueryPattern | null = null;
        for (const pattern of patterns) {
          if (pattern.match(question)) { matchedPattern = pattern; break; }
        }

        if (!matchedPattern) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'ask_about_data',
                'Could not understand the question.',
                'Try rephrasing, or use run_screen for precise numeric conditions.'
              ),
            }],
          };
        }

        const queryInfo = await matchedPattern.buildQuery(question, db);
        const { rows } = await db.query(queryInfo.sql, queryInfo.params);
        const summary = matchedPattern.formatSummary(rows, queryInfo.description);

        const result = {
          question,
          interpretation: queryInfo.description,
          patternUsed: matchedPattern.id,
          data: rows,
          rowCount: rows.length,
        };

        if (rows.length > 0) await cacheSet(key, result, TTL.SCREEN_RESULTS);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary,
              data: result,
              context: {
                count: rows.length,
                units: { market_cap_cr: 'INR Crores', roe: 'Decimal (0.15 = 15%)', roce: 'Decimal', pe_ratio: 'x (times)', dividend_yield: 'Decimal (0.03 = 3%)' },
              },
              relatedTools: ['run_screen', 'get_company_profile', 'get_valuation_metrics', 'get_sector_overview'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'ask_about_data',
              err instanceof Error ? err.message : 'Query failed',
              'Try rephrasing your question, or use run_screen for precise numeric conditions.'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // explain_company
  // ------------------------------------------------------------------
  server.tool(
    'explain_company',
    'Get a comprehensive structured summary of an Indian listed company including ' +
    'what it does, how it makes money, financial health assessment, recent performance, ' +
    'and investment considerations. Returns a narrative optimized for presenting to users. ' +
    'Use this as the starting point when a user asks about any company. ' +
    'Example: explain_company({ ticker: "INFY" })',
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol, e.g. "RELIANCE", "TCS". .NS/.BO suffixes stripped automatically.'
      ),
    },
    async ({ ticker }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const key = cacheKey('explain', normalized);
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Company explanation for ${normalized} (cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['get_income_statement', 'get_financial_ratios', 'calculate_dcf', 'get_company_peers', 'compare_investment_thesis'],
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
                'explain_company',
                `Company "${normalized}" not found.`,
                suggestions.length > 0
                  ? `Did you mean: ${suggestions.map((s: { ticker: string }) => s.ticker).join(', ')}?`
                  : 'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        const bundle = await fetchCompanyDataBundle(db, company.id);
        bundle.company = company;
        const r = bundle.ratios[0]; // latest ratios
        const sh = bundle.shareholding[0]; // latest shareholding
        const mcap = toNum(company.market_cap_cr);

        // a) Overview
        const listingDate = company.listing_date ? new Date(String(company.listing_date)) : null;
        const yearsSinceListing = listingDate ? Math.round((Date.now() - listingDate.getTime()) / (365.25 * 86400000)) : null;
        const overview = {
          name: company.company_name,
          ticker: normalized,
          sector: company.sector,
          industry: company.industry,
          marketCapCr: mcap,
          marketCapTier: marketCapTier(mcap),
          yearsSinceListing,
        };

        // b) Business model (generic, derived from sector/industry)
        const latestAnnual = bundle.annuals[0];
        const revenue = latestAnnual ? toNum(latestAnnual.revenue) : null;
        const businessModel = {
          description: `Operates in the ${company.industry ?? 'N/A'} segment of ${company.sector ?? 'N/A'}.`,
          revenueScale: revenue ? `Generates approximately Rs ${Math.round(revenue)} Cr in annual revenue.` : null,
        };

        // c) Financial health
        const financialHealth = deriveFinancialHealth(r, bundle.annuals, sh);

        // d) Recent performance (last 2 quarters)
        const recentQ = bundle.quarterlies.slice(0, 2).map((q: Record<string, unknown>) => ({
          quarter: `Q${q.quarter} FY${q.fiscal_year}`,
          revenueCr: toNum(q.revenue),
          netProfitCr: toNum(q.net_profit),
        }));

        // e) Key metrics
        const keyMetrics = r ? {
          revenueCr: revenue,
          netProfitCr: latestAnnual ? toNum(latestAnnual.net_profit) : null,
          marketCapCr: mcap,
          pe: toNumOrNull(r.pe_ratio),
          pb: toNumOrNull(r.pb_ratio),
          roe: toNumOrNull(r.roe),
          roce: toNumOrNull(r.roce),
          debtToEquity: toNumOrNull(r.debt_to_equity),
          dividendYield: toNumOrNull(r.dividend_yield),
          promoterHolding: sh ? toNumOrNull(sh.promoter_holding) : null,
          fiscalYear: r.fiscal_year,
        } : null;

        // f) Investment considerations
        const bull: string[] = [];
        const bear: string[] = [];
        if (r) {
          const roe = toNum(r.roe);
          const dte = toNum(r.debt_to_equity);
          const revCagr3 = toNum(r.revenue_cagr_3y);
          const promHolding = sh ? toNum(sh.promoter_holding) : 0;
          const fcf = toNum(r.fcf);

          if (roe > 0.15 && revCagr3 > 0) bull.push('Strong and growing ROE');
          if (revCagr3 > 0.10) bull.push('Consistent revenue growth');
          if (dte < 0.3) bull.push('Very low debt');
          if (promHolding > 50) bull.push(`High promoter holding (${roundTo(promHolding, 1)}%)`);

          // PE vs 5Y average
          const peValues = bundle.ratios.map(rr => toNum(rr.pe_ratio)).filter(v => v > 0);
          const avgPe = peValues.length > 0 ? peValues.reduce((s, v) => s + v, 0) / peValues.length : 0;
          const currentPe = toNum(r.pe_ratio);
          if (avgPe > 0 && currentPe > 0 && currentPe < avgPe) bull.push(`Trading below 5Y average PE (${roundTo(currentPe, 1)} vs ${roundTo(avgPe, 1)})`);

          if (bundle.annuals.length >= 2) {
            const m0 = toNum(bundle.annuals[0].operating_profit) / Math.max(toNum(bundle.annuals[0].revenue), 1);
            const m1 = toNum(bundle.annuals[1].operating_profit) / Math.max(toNum(bundle.annuals[1].revenue), 1);
            if (m0 < m1 * 0.9) bear.push('Declining margins');
          }
          if (dte > 1) bear.push('Rising/high debt');
          if (sh && bundle.shareholding.length >= 2) {
            const promNow = toNum(bundle.shareholding[0].promoter_holding);
            const promPrev = toNum(bundle.shareholding[1].promoter_holding);
            if (promNow < promPrev - 1) bear.push('Falling promoter holding');
          }
          if (avgPe > 0 && currentPe > avgPe) bear.push(`Trading above 5Y average PE (${roundTo(currentPe, 1)} vs ${roundTo(avgPe, 1)})`);
          if (fcf < 0) bear.push('Negative free cash flow');
        }

        // g) Data freshness
        const dataFreshness = {
          latestAnnual: latestAnnual ? `FY${latestAnnual.fiscal_year}` : null,
          latestQuarter: bundle.quarterlies[0] ? `Q${bundle.quarterlies[0].quarter} FY${bundle.quarterlies[0].fiscal_year}` : null,
          priceAsOf: bundle.latestPrice?.trade_date ?? null,
        };

        const result = {
          overview,
          businessModel,
          financialHealth,
          recentPerformance: recentQ,
          keyMetrics,
          investmentConsiderations: { bull, bear },
          dataFreshness,
        };

        await cacheSet(key, result, 3600);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${company.company_name} (${normalized}) -- ${marketCapTier(mcap)}-cap ${company.sector}. ${financialHealth.strengths.length} strength(s), ${financialHealth.concerns.length} concern(s).`,
              data: result,
              context: {
                ticker: normalized,
                units: { values: 'INR Crores', ratios: 'Decimal (0.15 = 15%)', holdings: '%' },
              },
              relatedTools: ['get_income_statement', 'get_financial_ratios', 'calculate_dcf', 'get_company_peers', 'compare_investment_thesis'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'explain_company',
              err instanceof Error ? err.message : 'Company explanation failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // compare_investment_thesis
  // ------------------------------------------------------------------
  server.tool(
    'compare_investment_thesis',
    'Compare 2-5 Indian listed companies across business profile, growth, profitability, ' +
    'valuation, balance sheet strength, and shareholding quality. Returns a structured ' +
    'comparison with per-dimension assessments. ' +
    'Example: compare_investment_thesis({ tickers: ["HDFCBANK", "ICICIBANK", "KOTAKBANK"] })',
    {
      tickers: z.array(z.string().min(1)).min(2).max(5).describe(
        'Array of 2-5 ticker symbols to compare'
      ),
    },
    async ({ tickers }) => {
      try {
        const normalizedTickers = tickers.map(normalizeTicker);
        const sortedKey = [...normalizedTickers].sort().join(',');
        const key = cacheKey('compare', sortedKey);
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Investment thesis comparison (cached)`,
                data: cached,
                context: {},
                relatedTools: ['explain_company', 'compare_financials', 'get_valuation_metrics', 'get_company_peers'],
              }),
            }],
          };
        }

        const warnings: string[] = [];
        const companyBundles: Array<{ ticker: string; company: Record<string, unknown>; bundle: CompanyDataBundle }> = [];

        // Fetch all bundles in parallel
        const lookups = normalizedTickers.map(async (t) => {
          const company = await queries.getCompanyByTicker(db, t);
          if (!company) { warnings.push(`Ticker "${t}" not found -- excluded.`); return null; }
          const bundle = await fetchCompanyDataBundle(db, company.id);
          bundle.company = company;
          return { ticker: t, company, bundle };
        });

        const results = await Promise.all(lookups);
        for (const r of results) { if (r) companyBundles.push(r); }

        if (companyBundles.length < 2) {
          return {
            content: [{
              type: 'text' as const,
              text: buildErrorResponse(
                'compare_investment_thesis',
                `Need at least 2 valid companies to compare. Found ${companyBundles.length}.`,
                warnings.length > 0 ? warnings.join(' ') : 'Check your ticker symbols.'
              ),
            }],
          };
        }

        // Helper to build dimension comparison
        type DimEntry = { ticker: string; value: number | null; [k: string]: unknown };
        function buildDimension(
          label: string,
          extractor: (cb: typeof companyBundles[0]) => DimEntry,
          higherIsBetter: boolean
        ): { dimension: string; entries: DimEntry[]; leader: string | null } {
          const entries = companyBundles.map(extractor);
          const valid = entries.filter(e => e.value !== null);
          let leader: string | null = null;
          if (valid.length > 0) {
            valid.sort((a, b) => higherIsBetter ? toNum(b.value) - toNum(a.value) : toNum(a.value) - toNum(b.value));
            leader = valid[0].ticker;
          }
          return { dimension: label, entries, leader };
        }

        // a) Scale
        const scale = buildDimension('scale', (cb) => ({
          ticker: cb.ticker,
          marketCapCr: toNum(cb.company.market_cap_cr),
          revenueCr: cb.bundle.annuals[0] ? toNum(cb.bundle.annuals[0].revenue) : null,
          netProfitCr: cb.bundle.annuals[0] ? toNum(cb.bundle.annuals[0].net_profit) : null,
          value: cb.bundle.annuals[0] ? toNum(cb.bundle.annuals[0].revenue) : null,
        }), true);

        // b) Growth
        const growth = buildDimension('growth', (cb) => {
          const r = cb.bundle.ratios[0];
          return {
            ticker: cb.ticker,
            revenueCagr3y: r ? toNumOrNull(r.revenue_cagr_3y) : null,
            revenueCagr5y: r ? toNumOrNull(r.revenue_cagr_5y) : null,
            profitCagr3y: r ? toNumOrNull(r.profit_cagr_3y) : null,
            profitCagr5y: r ? toNumOrNull(r.profit_cagr_5y) : null,
            latestQtrRevGrowth: r ? toNumOrNull(r.revenue_growth_yoy) : null,
            value: r ? toNumOrNull(r.revenue_cagr_3y) : null,
          };
        }, true);

        // c) Profitability
        const profitability = buildDimension('profitability', (cb) => {
          const r = cb.bundle.ratios[0];
          return {
            ticker: cb.ticker,
            roe: r ? toNumOrNull(r.roe) : null,
            roce: r ? toNumOrNull(r.roce) : null,
            operatingMargin: r ? toNumOrNull(r.operating_margin) : null,
            netMargin: r ? toNumOrNull(r.net_margin) : null,
            value: r ? toNumOrNull(r.roce) : null,
          };
        }, true);

        // d) Valuation (lower PE = better)
        const valuation = buildDimension('valuation', (cb) => {
          const r = cb.bundle.ratios[0];
          return {
            ticker: cb.ticker,
            pe: r ? toNumOrNull(r.pe_ratio) : null,
            pb: r ? toNumOrNull(r.pb_ratio) : null,
            evEbitda: r ? toNumOrNull(r.ev_ebitda) : null,
            earningsYield: r ? toNumOrNull(r.earnings_yield) : null,
            value: r ? toNumOrNull(r.pe_ratio) : null,
          };
        }, false);

        // e) Balance sheet (lower D/E = better)
        const balanceSheet = buildDimension('balanceSheet', (cb) => {
          const r = cb.bundle.ratios[0];
          return {
            ticker: cb.ticker,
            debtToEquity: r ? toNumOrNull(r.debt_to_equity) : null,
            currentRatio: r ? toNumOrNull(r.current_ratio) : null,
            interestCoverage: r ? toNumOrNull(r.interest_coverage) : null,
            value: r ? toNumOrNull(r.debt_to_equity) : null,
          };
        }, false);

        // f) Cash flow
        const cashFlow = buildDimension('cashFlow', (cb) => {
          const r = cb.bundle.ratios[0];
          return {
            ticker: cb.ticker,
            fcf: r ? toNumOrNull(r.fcf) : null,
            fcfYield: r ? toNumOrNull(r.fcf_yield) : null,
            value: r ? toNumOrNull(r.fcf_yield) : null,
          };
        }, true);

        // g) Shareholding (higher promoter = better)
        const shareholding = buildDimension('shareholding', (cb) => {
          const sh = cb.bundle.shareholding[0];
          return {
            ticker: cb.ticker,
            promoterHolding: sh ? toNumOrNull(sh.promoter_holding) : null,
            fiiHolding: sh ? toNumOrNull(sh.fii_holding) : null,
            pledgedPct: sh ? toNumOrNull(sh.pledged_percentage) : null,
            value: sh ? toNumOrNull(sh.promoter_holding) : null,
          };
        }, true);

        // h) Momentum
        const momentum = buildDimension('momentum', (cb) => {
          const ret1m = computePriceReturns(cb.bundle.prices365, 30);
          const ret3m = computePriceReturns(cb.bundle.prices365, 90);
          const ret1y = computePriceReturns(cb.bundle.prices365, 365);
          return {
            ticker: cb.ticker,
            return1m: ret1m,
            return3m: ret3m,
            return1y: ret1y,
            value: ret1y,
          };
        }, true);

        const dimensions = [scale, growth, profitability, valuation, balanceSheet, cashFlow, shareholding, momentum];

        // Summary: one sentence per dimension
        const dimensionSummaries = dimensions.map(d => {
          if (!d.leader) return `${d.dimension}: insufficient data`;
          const leaderEntry = d.entries.find(e => e.ticker === d.leader);
          const val = leaderEntry?.value;
          const valStr = val !== null && val !== undefined ? ` (${typeof val === 'number' ? roundTo(val, 2) : val})` : '';
          return `${d.leader} leads on ${d.dimension}${valStr}`;
        });

        const result = {
          tickers: companyBundles.map(cb => cb.ticker),
          dimensions: Object.fromEntries(dimensions.map(d => [d.dimension, d])),
          summary: dimensionSummaries,
          warnings,
        };

        await cacheSet(key, result, 1800);

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `Comparison of ${companyBundles.map(cb => cb.ticker).join(', ')} across 8 dimensions.${warnings.length > 0 ? ` ${warnings.length} warning(s).` : ''}`,
              data: result,
              context: {
                units: { values: 'INR Crores', ratios: 'Decimal (0.15 = 15%)', returns: '%', holdings: '%' },
              },
              relatedTools: ['explain_company', 'compare_financials', 'get_valuation_metrics', 'get_company_peers'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'compare_investment_thesis',
              err instanceof Error ? err.message : 'Investment thesis comparison failed'
            ),
          }],
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // generate_research_report
  // ------------------------------------------------------------------
  server.tool(
    'generate_research_report',
    'Generate a structured equity research report for an Indian listed company, populated ' +
    'with real financial data. Three depth levels: brief (key metrics snapshot), standard ' +
    '(full analysis), deep (comprehensive with historical trends and peer comparison). ' +
    'Example: generate_research_report({ ticker: "RELIANCE", depth: "standard" })',
    {
      ticker: z.string().min(1).describe(
        'Company ticker symbol. .NS/.BO suffixes stripped automatically.'
      ),
      depth: z.enum(['brief', 'standard', 'deep']).describe(
        'Report depth: "brief" (3 sections), "standard" (7 sections), "deep" (10 sections)'
      ),
    },
    async ({ ticker, depth }) => {
      try {
        const normalized = normalizeTicker(ticker);
        const key = cacheKey('report', normalized, { depth });
        const cached = await cacheGet(key);
        if (cached) {
          return {
            content: [{
              type: 'text' as const,
              text: buildResponse({
                summary: `Research report for ${normalized} (${depth}, cached)`,
                data: cached,
                context: { ticker: normalized },
                relatedTools: ['explain_company', 'compare_investment_thesis', 'get_income_statement', 'calculate_dcf', 'get_technical_summary'],
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
                'generate_research_report',
                `Company "${normalized}" not found.`,
                suggestions.length > 0
                  ? `Did you mean: ${suggestions.map((s: { ticker: string }) => s.ticker).join(', ')}?`
                  : 'Use search_companies to find the correct ticker.'
              ),
            }],
          };
        }

        const bundle = await fetchCompanyDataBundle(db, company.id);
        bundle.company = company;
        const r = bundle.ratios[0];
        const sh = bundle.shareholding[0];
        const mcap = toNum(company.market_cap_cr);
        const latestAnnual = bundle.annuals[0];

        // ---- BRIEF sections (always included) ----
        const companySnapshot = {
          name: company.company_name,
          ticker: normalized,
          sector: company.sector,
          industry: company.industry,
          marketCapCr: mcap,
          marketCapTier: marketCapTier(mcap),
          latestPrice: bundle.latestPrice ? toNum(bundle.latestPrice.close_price) : null,
          priceDate: bundle.latestPrice?.trade_date ?? null,
          pe: r ? toNumOrNull(r.pe_ratio) : null,
          pb: r ? toNumOrNull(r.pb_ratio) : null,
          roe: r ? toNumOrNull(r.roe) : null,
          roce: r ? toNumOrNull(r.roce) : null,
          debtToEquity: r ? toNumOrNull(r.debt_to_equity) : null,
          dividendYield: r ? toNumOrNull(r.dividend_yield) : null,
        };

        const financialHighlights = latestAnnual ? {
          fiscalYear: latestAnnual.fiscal_year,
          revenueCr: toNum(latestAnnual.revenue),
          netProfitCr: toNum(latestAnnual.net_profit),
          operatingMargin: r ? toNumOrNull(r.operating_margin) : null,
          netMargin: r ? toNumOrNull(r.net_margin) : null,
          revenueGrowthYoY: r ? toNumOrNull(r.revenue_growth_yoy) : null,
          profitGrowthYoY: r ? toNumOrNull(r.profit_growth_yoy) : null,
          epsCr: toNumOrNull(latestAnnual.eps),
        } : null;

        const healthData = deriveFinancialHealth(r, bundle.annuals, sh);
        const quickTake = {
          strengths: healthData.strengths.slice(0, 3),
          concerns: healthData.concerns.slice(0, 3),
        };

        const report: Record<string, unknown> = {
          companySnapshot,
          financialHighlights,
          quickTake,
        };

        // ---- STANDARD sections (brief + 4 more) ----
        if (depth === 'standard' || depth === 'deep') {
          const listingDate = company.listing_date ? new Date(String(company.listing_date)) : null;
          report.businessOverview = {
            sector: company.sector,
            industry: company.industry,
            marketCapTier: marketCapTier(mcap),
            yearsListed: listingDate ? Math.round((Date.now() - listingDate.getTime()) / (365.25 * 86400000)) : null,
            revenueScale: latestAnnual ? `Rs ${Math.round(toNum(latestAnnual.revenue))} Cr` : null,
          };

          // Financial analysis: 5-year trends
          const financialAnalysis: Record<string, unknown> = {};
          if (bundle.annuals.length >= 2) {
            const revTrend = bundle.annuals.map(a => ({ year: a.fiscal_year, revenue: toNum(a.revenue), netProfit: toNum(a.net_profit) })).reverse();
            const firstRev = toNum(bundle.annuals[bundle.annuals.length - 1].revenue);
            const lastRev = toNum(bundle.annuals[0].revenue);
            const years = bundle.annuals.length - 1;
            financialAnalysis.revenueProfitTrend = revTrend;
            financialAnalysis.revenueCagr = years > 0 && firstRev > 0 ? roundTo((cagr(firstRev, lastRev, years) ?? 0) * 100, 2) : null;
            const firstProf = toNum(bundle.annuals[bundle.annuals.length - 1].net_profit);
            const lastProf = toNum(bundle.annuals[0].net_profit);
            financialAnalysis.profitCagr = years > 0 && firstProf > 0 ? roundTo((cagr(firstProf, lastProf, years) ?? 0) * 100, 2) : null;
          }
          if (bundle.ratios.length >= 2) {
            financialAnalysis.marginTrend = bundle.ratios.map(rr => ({ year: rr.fiscal_year, opMargin: toNumOrNull(rr.operating_margin), netMargin: toNumOrNull(rr.net_margin) })).reverse();
            financialAnalysis.roceTrend = bundle.ratios.map(rr => ({ year: rr.fiscal_year, roe: toNumOrNull(rr.roe), roce: toNumOrNull(rr.roce) })).reverse();
            financialAnalysis.debtTrend = bundle.ratios.map(rr => ({ year: rr.fiscal_year, debtToEquity: toNumOrNull(rr.debt_to_equity) })).reverse();
          }
          report.financialAnalysis = financialAnalysis;

          // Valuation assessment
          const valuationAssessment: Record<string, unknown> = {};
          if (r) {
            const peValues = bundle.ratios.map(rr => toNum(rr.pe_ratio)).filter(v => v > 0);
            const avgPe = peValues.length > 0 ? roundTo(peValues.reduce((s, v) => s + v, 0) / peValues.length, 2) : null;
            const medianPe = peValues.length > 0 ? roundTo(peValues.sort((a, b) => a - b)[Math.floor(peValues.length / 2)], 2) : null;
            valuationAssessment.currentPe = toNumOrNull(r.pe_ratio);
            valuationAssessment.historicalAvgPe = avgPe;
            valuationAssessment.historicalMedianPe = medianPe;
            valuationAssessment.currentPb = toNumOrNull(r.pb_ratio);

            // Graham number
            const epsVal = latestAnnual ? toNum(latestAnnual.eps) : 0;
            const bvps = r.book_value_per_share ? toNum(r.book_value_per_share) : 0;
            const gn = grahamNumber(epsVal, bvps);
            valuationAssessment.grahamNumber = gn !== null ? roundTo(gn, 2) : null;

            // Simple DCF
            const fcfVal = toNum(r.fcf);
            if (fcfVal > 0) {
              const growthRate = Math.min(toNum(r.revenue_cagr_3y), 0.20);
              const dcf = dcfValuation({
                lastFcf: fcfVal,
                growthRate: Math.max(growthRate, 0.05),
                discountRate: 0.12,
                terminalGrowthRate: 0.04,
                projectionYears: 10,
                sharesOutstanding: mcap > 0 && bundle.latestPrice ? Math.round(mcap * 10000000 / toNum(bundle.latestPrice.close_price)) : 1,
                netDebt: latestAnnual ? toNum(latestAnnual.total_borrowings) : 0,
              });
              valuationAssessment.dcfIntrinsicValue = roundTo(dcf.intrinsicValue, 2);
              const latPrice = bundle.latestPrice ? toNum(bundle.latestPrice.close_price) : 0;
              valuationAssessment.marginOfSafety = latPrice > 0 ? roundTo((dcf.intrinsicValue - latPrice) / latPrice * 100, 2) : null;
            }
          }
          report.valuationAssessment = valuationAssessment;

          // Shareholding analysis
          const shareholdingAnalysis: Record<string, unknown> = {
            current: sh ? {
              promoter: toNumOrNull(sh.promoter_holding),
              fii: toNumOrNull(sh.fii_holding),
              dii: toNumOrNull(sh.dii_holding),
              public: toNumOrNull(sh.public_holding),
              pledged: toNumOrNull(sh.pledged_percentage),
            } : null,
            trend: bundle.shareholding.map(s => ({
              quarter: s.quarter_end_date,
              promoter: toNumOrNull(s.promoter_holding),
              fii: toNumOrNull(s.fii_holding),
              dii: toNumOrNull(s.dii_holding),
            })).reverse(),
            recentInsiderTrades: bundle.insiderTrades.length,
            insiderTradesSummary: bundle.insiderTrades.slice(0, 5).map(t => ({
              name: t.insider_name, type: t.transaction_type, shares: t.shares, valueCr: t.value_cr, date: t.trade_date,
            })),
          };
          report.shareholdingAnalysis = shareholdingAnalysis;
        }

        // ---- DEEP sections (standard + 3 more) ----
        if (depth === 'deep') {
          // Quarterly trend
          const quarterlyTrend = bundle.quarterlies.map(q => ({
            quarter: `Q${q.quarter} FY${q.fiscal_year}`,
            revenueCr: toNum(q.revenue),
            netProfitCr: toNum(q.net_profit),
          })).reverse();
          report.quarterlyTrend = quarterlyTrend;

          // Peer comparison
          const peers = await queries.getCompanyPeers(db, company.id, 5);
          const peerData: Array<Record<string, unknown>> = [];
          for (const peer of peers) {
            const peerRatios = await queries.getRatios(db, (peer as Record<string, unknown>).id as number, 1);
            const pr = peerRatios[0] as Record<string, unknown> | undefined;
            peerData.push({
              ticker: (peer as Record<string, unknown>).ticker,
              name: (peer as Record<string, unknown>).company_name,
              marketCapCr: toNum((peer as Record<string, unknown>).market_cap_cr),
              pe: pr ? toNumOrNull(pr.pe_ratio) : null,
              roe: pr ? toNumOrNull(pr.roe) : null,
              roce: pr ? toNumOrNull(pr.roce) : null,
              debtToEquity: pr ? toNumOrNull(pr.debt_to_equity) : null,
            });
          }
          report.peerComparison = {
            companyMetrics: {
              pe: r ? toNumOrNull(r.pe_ratio) : null,
              roe: r ? toNumOrNull(r.roe) : null,
              roce: r ? toNumOrNull(r.roce) : null,
              debtToEquity: r ? toNumOrNull(r.debt_to_equity) : null,
            },
            peers: peerData,
          };

          // Technical overview
          const closes = bundle.prices365.map(p => toNum(p.close_price));
          if (closes.length >= 50) {
            const sma50 = sma(closes, 50);
            const sma200 = closes.length >= 200 ? sma(closes, 200) : [];
            const ema50 = ema(closes, 50);
            const rsiValues = rsi(closes, 14);
            const macdResult = macd(closes);
            const currentClose = closes[closes.length - 1];
            const high52w = Math.max(...closes);
            const low52w = Math.min(...closes);

            const macdHasData = macdResult.macdLine.length > 0 && macdResult.signalLine.length > 0;

            report.technicalOverview = {
              currentPrice: roundTo(currentClose, 2),
              sma50: sma50.length > 0 ? roundTo(sma50[sma50.length - 1], 2) : null,
              sma200: sma200.length > 0 ? roundTo(sma200[sma200.length - 1], 2) : null,
              ema50: ema50.length > 0 ? roundTo(ema50[ema50.length - 1], 2) : null,
              rsi14: rsiValues.length > 0 ? roundTo(rsiValues[rsiValues.length - 1], 2) : null,
              macdSignal: macdHasData ? {
                macd: roundTo(macdResult.macdLine[macdResult.macdLine.length - 1], 4),
                signal: roundTo(macdResult.signalLine[macdResult.signalLine.length - 1], 4),
                histogram: macdResult.histogram.length > 0 ? roundTo(macdResult.histogram[macdResult.histogram.length - 1], 4) : null,
              } : null,
              week52High: roundTo(high52w, 2),
              week52Low: roundTo(low52w, 2),
              distFromHigh: roundTo((currentClose - high52w) / high52w * 100, 2),
              distFromLow: roundTo((currentClose - low52w) / low52w * 100, 2),
            };
          } else {
            report.technicalOverview = { note: 'Insufficient price data for technical analysis (need at least 50 days).' };
          }
        }

        report.depth = depth;
        report.ticker = normalized;
        report.generatedAt = new Date().toISOString();

        await cacheSet(key, report, 3600);

        const sectionCount = Object.keys(report).filter(k => !['depth', 'ticker', 'generatedAt'].includes(k)).length;

        return {
          content: [{
            type: 'text' as const,
            text: buildResponse({
              summary: `${depth.charAt(0).toUpperCase() + depth.slice(1)} research report for ${company.company_name} (${normalized}): ${sectionCount} section(s).`,
              data: report,
              context: {
                ticker: normalized,
                depth,
                units: { values: 'INR Crores', ratios: 'Decimal (0.15 = 15%)', prices: 'INR', returns: '%' },
                disclaimer: 'This report is a mechanical compilation of available data. It is not investment advice.',
              },
              relatedTools: ['explain_company', 'compare_investment_thesis', 'get_income_statement', 'calculate_dcf', 'get_technical_summary'],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: buildErrorResponse(
              'generate_research_report',
              err instanceof Error ? err.message : 'Research report generation failed'
            ),
          }],
        };
      }
    }
  );
}
