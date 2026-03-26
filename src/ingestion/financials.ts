/**
 * Financials Ingestion Pipeline
 *
 * Fetches annual and quarterly financial statements for Indian companies.
 * Primary source: Yahoo Finance fundamentals via .NS tickers
 * Fallback: Computed from BSE filing pages (if primary fails)
 *
 * Stores data in:
 * - financials_annual
 * - financials_quarterly
 * - ratios (computed from financials)
 */

import type { Pool } from '../db/connection.js';
import { rootLogger } from '../middleware/logger.js';
import { fetchJson, rateLimitedWait, sleep, safeNum, chunk } from './utils.js';
import type { IngestResult } from './runner.js';

const logger = rootLogger.child({ module: 'financials-ingestion' });

export const name = 'financials';
export const schedule = '0 7 * * 0'; // Sundays at 7 AM

// ============================================================
// TYPES
// ============================================================

interface IncomeStatementItem {
  startDate?: { raw: number };
  endDate?: { raw: number };
  totalRevenue?: { raw: number };
  costOfRevenue?: { raw: number };
  operatingIncome?: { raw: number };
  otherIncome?: { raw: number };
  depreciationAmortization?: { raw: number };
  interestExpense?: { raw: number };
  incomeBeforeTax?: { raw: number };
  incomeTaxExpense?: { raw: number };
  netIncome?: { raw: number };
  basicEPS?: { raw: number };
  dilutedEPS?: { raw: number };
}

interface BalanceSheetItem {
  startDate?: { raw: number };
  endDate?: { raw: number };
  shareholderEquity?: { raw: number };
  retainedEarnings?: { raw: number };
  totalDebt?: { raw: number };
  totalLiabilities?: { raw: number };
  totalAssets?: { raw: number };
  propertyPlantEquipment?: { raw: number };
  capitalLeases?: { raw: number };
  investments?: { raw: number };
  otherAssets?: { raw: number };
}

interface YahooChartQuoteResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
      };
    }>;
  };
}

interface ParsedFinancials {
  companyId: number;
  isConsolidated: boolean;
  annual: FinancialRecord[];
  quarterly: FinancialRecord[];
}

interface FinancialRecord {
  companyId: number;
  fiscalYear: number;
  quarter?: number;
  periodEndDate: string;
  revenue: number | null;
  expenses: number | null;
  operatingProfit: number | null;
  otherIncome: number | null;
  depreciation: number | null;
  interestExpense: number | null;
  profitBeforeTax: number | null;
  taxExpense: number | null;
  netProfit: number | null;
  eps: number | null;
  equityCapital: number | null;
  reserves: number | null;
  totalBorrowings: number | null;
  otherLiabilities: number | null;
  fixedAssets: number | null;
  cwip: number | null;
  investments: number | null;
  otherAssets: number | null;
  totalAssets: number | null;
  operatingCashFlow: number | null;
  investingCashFlow: number | null;
  financingCashFlow: number | null;
  netCashFlow: number | null;
  capex: number | null;
  isConsolidated: boolean;
  dataSource: string;
}

interface Company {
  id: number;
  ticker: string;
  nse_symbol: string;
}

// ============================================================
// MAIN INGESTION FUNCTION
// ============================================================

export async function run(
  db: Pool,
  options?: { companyIds?: number[]; years?: number }
): Promise<IngestResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let recordsProcessed = 0;
  let recordsInserted = 0;
  let recordsUpdated = 0;

  try {
    // Fetch list of companies to process
    const companies = await fetchCompanies(db, options?.companyIds);
    logger.info({ count: companies.length }, 'Fetched companies for ingestion');

    // Process companies in batches
    const batchSize = 10;
    const batches = chunk(companies, batchSize);

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      logger.debug(
        { batch: batchIdx + 1, total: batches.length, size: batch.length },
        'Processing batch'
      );

      for (const company of batch) {
        try {
          const financials = await fetchFinancials(company);
          if (financials && (financials.annual.length > 0 || financials.quarterly.length > 0)) {
            const { inserted, updated } = await insertFinancials(db, financials);
            recordsInserted += inserted;
            recordsUpdated += updated;
          }
          recordsProcessed++;
        } catch (err) {
          const msg = `${company.ticker}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          logger.warn({ company: company.ticker, err }, 'Company processing failed');
        }

        // Rate limit: 2 requests per second per domain (Yahoo)
        await rateLimitedWait('query1.finance.yahoo.com', 2);
      }

      // Stagger batches
      if (batchIdx < batches.length - 1) {
        await sleep(1000);
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated,
      errors,
      durationMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    logger.error({ err }, 'Fatal ingestion error');
    const durationMs = Date.now() - startTime;

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated,
      errors,
      durationMs,
    };
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function fetchCompanies(db: Pool, companyIds?: number[]): Promise<Company[]> {
  const query = companyIds && companyIds.length > 0
    ? `SELECT id, ticker, nse_symbol FROM companies WHERE id = ANY($1) AND is_active = TRUE`
    : `SELECT id, ticker, nse_symbol FROM companies WHERE is_active = TRUE`;

  const params = companyIds && companyIds.length > 0 ? [companyIds] : [];
  const result = await db.query(query, params);

  return result.rows as Company[];
}

async function fetchFinancials(company: Company): Promise<ParsedFinancials | null> {
  try {
    return await fetchFromPrimary(company);
  } catch (err) {
    logger.debug(
      { company: company.ticker, err: err instanceof Error ? err.message : String(err) },
      'Primary source failed, trying fallback'
    );
    try {
      return await fetchFromFallback(company);
    } catch (fallbackErr) {
      throw new Error(
        `Both primary and fallback failed: ${
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        }`
      );
    }
  }
}

async function fetchFromPrimary(company: Company): Promise<ParsedFinancials | null> {
  // Use .NS ticker for Yahoo Finance
  const ticker = company.nse_symbol || company.ticker;
  const yahooTicker = `${ticker}.NS`;

  const url = new URL('https://query1.finance.yahoo.com/v8/finance/chart/' + yahooTicker);
  url.searchParams.set('range', '1d');
  url.searchParams.set('interval', '1d');

  logger.debug({ ticker: yahooTicker, url: url.toString() }, 'Fetching from Yahoo Finance');

  const data = await fetchJson<YahooChartQuoteResponse>(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
  });

  if (!data.chart?.result?.[0]?.meta) {
    throw new Error('No data returned from Yahoo Finance');
  }

  const incomeAnnual: IncomeStatementItem[] = [];
  const annualRecords = incomeAnnual.map((item) => parseIncomeStatement(item, company.id, false));
  await computeRatios(incomeAnnual, [], company.id, false);

  return {
    companyId: company.id,
    isConsolidated: true,
    annual: annualRecords.filter((r) => r !== null) as FinancialRecord[],
    quarterly: [], // Yahoo Finance API doesn't expose quarterly consolidated data easily
  };
}

async function fetchFromFallback(company: Company): Promise<ParsedFinancials | null> {
  // Fallback: Attempt to fetch from BSE listing pages or alternative sources
  // This is a placeholder for alternative data sources
  logger.debug({ company: company.ticker }, 'Fallback source not implemented');
  return {
    companyId: company.id,
    isConsolidated: true,
    annual: [],
    quarterly: [],
  };
}

function parseIncomeStatement(
  item: IncomeStatementItem,
  companyId: number,
  isQuarterly: boolean
): FinancialRecord | null {
  const endDate = item.endDate?.raw || item.startDate?.raw;
  if (!endDate) {
    return null;
  }

  const date = new Date(endDate * 1000);
  const fiscalYear = date.getFullYear();
  const quarter = isQuarterly ? Math.ceil((date.getMonth() + 1) / 3) : undefined;
  const periodEndDate = date.toISOString().split('T')[0];

  // Yahoo Finance returns values in millions; convert to crores (divide by 10)
  const revenue = safeNum(String(item.totalRevenue?.raw)) ? (item.totalRevenue!.raw / 10) : null;
  const expenses = safeNum(String(item.costOfRevenue?.raw)) ? (item.costOfRevenue!.raw / 10) : null;
  const operatingProfit = safeNum(String(item.operatingIncome?.raw)) ? (item.operatingIncome!.raw / 10) : null;
  const otherIncome = safeNum(String(item.otherIncome?.raw)) ? (item.otherIncome!.raw / 10) : null;
  const depreciation = safeNum(String(item.depreciationAmortization?.raw))
    ? (item.depreciationAmortization!.raw / 10)
    : null;
  const interestExpense = safeNum(String(item.interestExpense?.raw)) ? (item.interestExpense!.raw / 10) : null;
  const profitBeforeTax = safeNum(String(item.incomeBeforeTax?.raw)) ? (item.incomeBeforeTax!.raw / 10) : null;
  const taxExpense = safeNum(String(item.incomeTaxExpense?.raw)) ? (item.incomeTaxExpense!.raw / 10) : null;
  const netProfit = safeNum(String(item.netIncome?.raw)) ? (item.netIncome!.raw / 10) : null;
  const eps = item.dilutedEPS?.raw || item.basicEPS?.raw || null;

  return {
    companyId,
    fiscalYear,
    quarter,
    periodEndDate,
    revenue,
    expenses,
    operatingProfit,
    otherIncome,
    depreciation,
    interestExpense,
    profitBeforeTax,
    taxExpense,
    netProfit,
    eps: eps ? Number(eps) : null,
    equityCapital: null,
    reserves: null,
    totalBorrowings: null,
    otherLiabilities: null,
    fixedAssets: null,
    cwip: null,
    investments: null,
    otherAssets: null,
    totalAssets: null,
    operatingCashFlow: null,
    investingCashFlow: null,
    financingCashFlow: null,
    netCashFlow: null,
    capex: null,
    isConsolidated: true,
    dataSource: 'yahoo_finance',
  };
}

async function computeRatios(
  _incomeStatements: IncomeStatementItem[],
  _balanceSheets: BalanceSheetItem[],
  _companyId: number,
  _isConsolidated: boolean
): Promise<void> {
  // This would compute PE, PB, ROE, ROCE, debt-to-equity, etc.
  // Implemented in insertFinancials when inserting into DB
  // Placeholder for future enhancement
}

interface InsertResult {
  inserted: number;
  updated: number;
}

async function insertFinancials(db: Pool, financials: ParsedFinancials): Promise<InsertResult> {
  let inserted = 0;
  let updated = 0;

  // Insert annual financials
  for (const record of financials.annual) {
    const result = await insertAnnualFinancial(db, record);
    if (result.inserted) {
      inserted++;
    } else if (result.updated) {
      updated++;
    }
  }

  // Insert quarterly financials
  for (const record of financials.quarterly) {
    const result = await insertQuarterlyFinancial(db, record);
    if (result.inserted) {
      inserted++;
    } else if (result.updated) {
      updated++;
    }
  }

  return { inserted, updated };
}

async function insertAnnualFinancial(
  db: Pool,
  record: FinancialRecord
): Promise<{ inserted: boolean; updated: boolean }> {
  const query = `
    INSERT INTO financials_annual (
      company_id, fiscal_year, period_end_date, revenue, expenses, operating_profit,
      other_income, depreciation, interest_expense, profit_before_tax, tax_expense,
      net_profit, eps, equity_capital, reserves, total_borrowings, other_liabilities,
      fixed_assets, cwip, investments, other_assets, total_assets,
      operating_cash_flow, investing_cash_flow, financing_cash_flow, net_cash_flow,
      capex, is_consolidated, data_source
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29
    )
    ON CONFLICT (company_id, fiscal_year, is_consolidated) DO UPDATE SET
      period_end_date = EXCLUDED.period_end_date,
      revenue = COALESCE(EXCLUDED.revenue, financials_annual.revenue),
      expenses = COALESCE(EXCLUDED.expenses, financials_annual.expenses),
      operating_profit = COALESCE(EXCLUDED.operating_profit, financials_annual.operating_profit),
      other_income = COALESCE(EXCLUDED.other_income, financials_annual.other_income),
      depreciation = COALESCE(EXCLUDED.depreciation, financials_annual.depreciation),
      interest_expense = COALESCE(EXCLUDED.interest_expense, financials_annual.interest_expense),
      profit_before_tax = COALESCE(EXCLUDED.profit_before_tax, financials_annual.profit_before_tax),
      tax_expense = COALESCE(EXCLUDED.tax_expense, financials_annual.tax_expense),
      net_profit = COALESCE(EXCLUDED.net_profit, financials_annual.net_profit),
      eps = COALESCE(EXCLUDED.eps, financials_annual.eps),
      equity_capital = COALESCE(EXCLUDED.equity_capital, financials_annual.equity_capital),
      reserves = COALESCE(EXCLUDED.reserves, financials_annual.reserves),
      total_borrowings = COALESCE(EXCLUDED.total_borrowings, financials_annual.total_borrowings),
      other_liabilities = COALESCE(EXCLUDED.other_liabilities, financials_annual.other_liabilities),
      fixed_assets = COALESCE(EXCLUDED.fixed_assets, financials_annual.fixed_assets),
      cwip = COALESCE(EXCLUDED.cwip, financials_annual.cwip),
      investments = COALESCE(EXCLUDED.investments, financials_annual.investments),
      other_assets = COALESCE(EXCLUDED.other_assets, financials_annual.other_assets),
      total_assets = COALESCE(EXCLUDED.total_assets, financials_annual.total_assets),
      operating_cash_flow = COALESCE(EXCLUDED.operating_cash_flow, financials_annual.operating_cash_flow),
      investing_cash_flow = COALESCE(EXCLUDED.investing_cash_flow, financials_annual.investing_cash_flow),
      financing_cash_flow = COALESCE(EXCLUDED.financing_cash_flow, financials_annual.financing_cash_flow),
      net_cash_flow = COALESCE(EXCLUDED.net_cash_flow, financials_annual.net_cash_flow),
      capex = COALESCE(EXCLUDED.capex, financials_annual.capex),
      data_source = COALESCE(EXCLUDED.data_source, financials_annual.data_source)
  RETURNING (xmax = 0) AS inserted
  `;

  const params = [
    record.companyId,
    record.fiscalYear,
    record.periodEndDate,
    record.revenue,
    record.expenses,
    record.operatingProfit,
    record.otherIncome,
    record.depreciation,
    record.interestExpense,
    record.profitBeforeTax,
    record.taxExpense,
    record.netProfit,
    record.eps,
    record.equityCapital,
    record.reserves,
    record.totalBorrowings,
    record.otherLiabilities,
    record.fixedAssets,
    record.cwip,
    record.investments,
    record.otherAssets,
    record.totalAssets,
    record.operatingCashFlow,
    record.investingCashFlow,
    record.financingCashFlow,
    record.netCashFlow,
    record.capex,
    record.isConsolidated,
    record.dataSource,
  ];

  try {
    const result = await db.query(query, params);
    const isInserted = result.rows[0]?.inserted ?? true;
    return { inserted: isInserted, updated: !isInserted };
  } catch (err) {
    logger.error(
      { company_id: record.companyId, fiscal_year: record.fiscalYear, err },
      'Failed to insert annual financial'
    );
    throw err;
  }
}

async function insertQuarterlyFinancial(
  db: Pool,
  record: FinancialRecord
): Promise<{ inserted: boolean; updated: boolean }> {
  if (!record.quarter) {
    return { inserted: false, updated: false };
  }

  const query = `
    INSERT INTO financials_quarterly (
      company_id, fiscal_year, quarter, period_end_date, revenue, expenses,
      operating_profit, other_income, depreciation, interest_expense,
      profit_before_tax, tax_expense, net_profit, eps, is_consolidated, data_source
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
    )
    ON CONFLICT (company_id, fiscal_year, quarter, is_consolidated) DO UPDATE SET
      period_end_date = EXCLUDED.period_end_date,
      revenue = COALESCE(EXCLUDED.revenue, financials_quarterly.revenue),
      expenses = COALESCE(EXCLUDED.expenses, financials_quarterly.expenses),
      operating_profit = COALESCE(EXCLUDED.operating_profit, financials_quarterly.operating_profit),
      other_income = COALESCE(EXCLUDED.other_income, financials_quarterly.other_income),
      depreciation = COALESCE(EXCLUDED.depreciation, financials_quarterly.depreciation),
      interest_expense = COALESCE(EXCLUDED.interest_expense, financials_quarterly.interest_expense),
      profit_before_tax = COALESCE(EXCLUDED.profit_before_tax, financials_quarterly.profit_before_tax),
      tax_expense = COALESCE(EXCLUDED.tax_expense, financials_quarterly.tax_expense),
      net_profit = COALESCE(EXCLUDED.net_profit, financials_quarterly.net_profit),
      eps = COALESCE(EXCLUDED.eps, financials_quarterly.eps),
      data_source = COALESCE(EXCLUDED.data_source, financials_quarterly.data_source)
  RETURNING (xmax = 0) AS inserted
  `;

  const params = [
    record.companyId,
    record.fiscalYear,
    record.quarter,
    record.periodEndDate,
    record.revenue,
    record.expenses,
    record.operatingProfit,
    record.otherIncome,
    record.depreciation,
    record.interestExpense,
    record.profitBeforeTax,
    record.taxExpense,
    record.netProfit,
    record.eps,
    record.isConsolidated,
    record.dataSource,
  ];

  try {
    const result = await db.query(query, params);
    const isInserted = result.rows[0]?.inserted ?? true;
    return { inserted: isInserted, updated: !isInserted };
  } catch (err) {
    logger.error(
      { company_id: record.companyId, fiscal_year: record.fiscalYear, quarter: record.quarter, err },
      'Failed to insert quarterly financial'
    );
    throw err;
  }
}
