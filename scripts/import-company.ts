import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';
import { pino } from 'pino';
import { getPool, closePool } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';

const logger = pino({ name: 'import-company' });

type Row = Array<string | number | null>;

interface ParsedWorkbook {
  ticker: string;
  companyName: string;
  faceValue: number | null;
  marketCapCr: number | null;
  annualRows: Array<{
    fiscalYear: number;
    periodEndDate: string | null;
    revenue: number | null;
    expenses: number | null;
    operatingProfit: number | null;
    otherIncome: number | null;
    depreciation: number | null;
    interestExpense: number | null;
    profitBeforeTax: number | null;
    taxExpense: number | null;
    netProfit: number | null;
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
    eps: number | null;
    price: number | null;
    bookValuePerShare: number | null;
  }>;
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const negativeMatch = trimmed.match(/^\((.*)\)$/);
  const core = (negativeMatch ? negativeMatch[1] : trimmed)
    .replace(/,/g, '')
    .replace(/%/g, '');

  const parsed = Number(core);
  if (!Number.isFinite(parsed)) return null;
  return negativeMatch ? -parsed : parsed;
}

function excelSerialToDate(value: unknown): Date | null {
  const serial = toNumber(value);
  if (serial === null) return null;
  const millis = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function isoDate(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

function getRowIndex(rows: Row[], label: string, start = 0, end = rows.length): number {
  const wanted = normalizeLabel(label);
  for (let i = start; i < end; i++) {
    if (normalizeLabel(rows[i]?.[0]) === wanted) return i;
  }
  return -1;
}

function getRowIndices(rows: Row[], label: string, start = 0, end = rows.length): number[] {
  const wanted = normalizeLabel(label);
  const idx: number[] = [];
  for (let i = start; i < end; i++) {
    if (normalizeLabel(rows[i]?.[0]) === wanted) idx.push(i);
  }
  return idx;
}

function getSeries(rows: Row[], label: string, start: number, end: number): Array<number | null> {
  const idx = getRowIndex(rows, label, start, end);
  if (idx < 0) return [];
  return rows[idx].slice(1).map(toNumber);
}

function align(series: Array<number | null>, size: number): Array<number | null> {
  if (series.length >= size) return series.slice(0, size);
  return [...series, ...new Array(size - series.length).fill(null)];
}

function parseWorkbook(filePath: string): ParsedWorkbook | null {
  const ticker = path.basename(filePath, path.extname(filePath)).toUpperCase().trim();
  const wb = xlsx.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets['Data Sheet'];
  if (!ws) {
    logger.warn({ filePath }, 'Skipping workbook without Data Sheet');
    return null;
  }

  const rawRows = xlsx.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    raw: true,
  }) as unknown[][];

  const rows: Row[] = rawRows.map((r) => r.map((v) => (typeof v === 'string' || typeof v === 'number' ? v : null)));

  const idxPL = getRowIndex(rows, 'PROFIT & LOSS');
  const idxQuarters = getRowIndex(rows, 'Quarters');
  const idxBS = getRowIndex(rows, 'BALANCE SHEET');
  const idxCF = getRowIndex(rows, 'CASH FLOW:');

  if (idxPL < 0 || idxQuarters < 0 || idxBS < 0 || idxCF < 0) {
    logger.warn({ filePath }, 'Skipping workbook with unexpected Data Sheet layout');
    return null;
  }

  const companyName = String(rows[0]?.[1] || ticker).trim() || ticker;
  const faceValue = toNumber(rows[getRowIndex(rows, 'Face Value')]?.[1]);
  const marketCapCr = toNumber(rows[getRowIndex(rows, 'Market Capitalization')]?.[1]);

  const reportDates = getSeries(rows, 'Report Date', idxPL, idxQuarters).map(excelSerialToDate);
  const yearCount = reportDates.length;

  if (yearCount === 0) {
    logger.warn({ filePath }, 'Skipping workbook with no annual report dates');
    return null;
  }

  const sales = align(getSeries(rows, 'Sales', idxPL, idxQuarters), yearCount);
  const expenses = align(getSeries(rows, 'Expenses', idxPL, idxQuarters), yearCount);
  const op = align(getSeries(rows, 'Operating Profit', idxPL, idxQuarters), yearCount);
  const otherIncome = align(getSeries(rows, 'Other Income', idxPL, idxQuarters), yearCount);
  const depreciation = align(getSeries(rows, 'Depreciation', idxPL, idxQuarters), yearCount);
  const interest = align(getSeries(rows, 'Interest', idxPL, idxQuarters), yearCount);
  const pbt = align(getSeries(rows, 'Profit before tax', idxPL, idxQuarters), yearCount);
  const tax = align(getSeries(rows, 'Tax', idxPL, idxQuarters), yearCount);
  const net = align(getSeries(rows, 'Net profit', idxPL, idxQuarters), yearCount);

  const equity = align(getSeries(rows, 'Equity Share Capital', idxBS, idxCF), yearCount);
  const reserves = align(getSeries(rows, 'Reserves', idxBS, idxCF), yearCount);
  const borrowings = align(getSeries(rows, 'Borrowings', idxBS, idxCF), yearCount);
  const otherLiabilities = align(getSeries(rows, 'Other Liabilities', idxBS, idxCF), yearCount);
  const fixedAssets = align(getSeries(rows, 'Net Block', idxBS, idxCF), yearCount);
  const cwip = align(getSeries(rows, 'Capital Work in Progress', idxBS, idxCF), yearCount);
  const investments = align(getSeries(rows, 'Investments', idxBS, idxCF), yearCount);
  const otherAssets = align(getSeries(rows, 'Other Assets', idxBS, idxCF), yearCount);
  const totalRows = getRowIndices(rows, 'Total', idxBS, idxCF);
  const totalAssets = align(totalRows.length > 1 ? rows[totalRows[1]].slice(1).map(toNumber) : getSeries(rows, 'Total', idxBS, idxCF), yearCount);

  const ocf = align(getSeries(rows, 'Cash from Operating Activity', idxCF, rows.length), yearCount);
  const icf = align(getSeries(rows, 'Cash from Investing Activity', idxCF, rows.length), yearCount);
  const fcf = align(getSeries(rows, 'Cash from Financing Activity', idxCF, rows.length), yearCount);
  const ncf = align(getSeries(rows, 'Net Cash Flow', idxCF, rows.length), yearCount);
  const prices = align(getSeries(rows, 'PRICE:', idxCF, rows.length), yearCount);
  const adjustedSharesCr = align(getSeries(rows, 'Adjusted Equity Shares in Cr', idxCF, rows.length), yearCount);
  const sharesAbsolute = align(getSeries(rows, 'No. of Equity Shares', idxBS, idxCF), yearCount);

  const annualRows = reportDates.map((d, i) => {
    const period = isoDate(d);
    const fiscalYear = d ? d.getUTCFullYear() : 0;
    const sharesCr = adjustedSharesCr[i] ?? (sharesAbsolute[i] !== null ? sharesAbsolute[i]! / 1e7 : null);
    const eps = sharesCr && sharesCr > 0 && net[i] !== null ? net[i]! / sharesCr : null;
    const bvps = sharesCr && sharesCr > 0
      ? ((equity[i] ?? 0) + (reserves[i] ?? 0)) / sharesCr
      : null;

    return {
      fiscalYear,
      periodEndDate: period,
      revenue: sales[i],
      expenses: expenses[i],
      operatingProfit: op[i],
      otherIncome: otherIncome[i],
      depreciation: depreciation[i],
      interestExpense: interest[i],
      profitBeforeTax: pbt[i],
      taxExpense: tax[i],
      netProfit: net[i],
      equityCapital: equity[i],
      reserves: reserves[i],
      totalBorrowings: borrowings[i],
      otherLiabilities: otherLiabilities[i],
      fixedAssets: fixedAssets[i],
      cwip: cwip[i],
      investments: investments[i],
      otherAssets: otherAssets[i],
      totalAssets: totalAssets[i],
      operatingCashFlow: ocf[i],
      investingCashFlow: icf[i],
      financingCashFlow: fcf[i],
      netCashFlow: ncf[i],
      eps,
      price: prices[i],
      bookValuePerShare: bvps,
    };
  }).filter((r) => r.fiscalYear > 0);

  return {
    ticker,
    companyName,
    faceValue,
    marketCapCr,
    annualRows,
  };
}

function growthYoY(current: number | null, prev: number | null): number | null {
  if (current === null || prev === null || prev === 0) return null;
  return (current - prev) / Math.abs(prev);
}

async function upsertCompanyAndFinancials(parsed: ParsedWorkbook): Promise<{ insertedAnnual: number; upsertedRatios: number }> {
  const db = getPool();

  const companyResult = await db.query(
    `INSERT INTO companies (
      ticker, company_name, nse_symbol, market_cap_cr, face_value, exchange, is_active
    ) VALUES ($1, $2, $3, $4, $5, 'NSE', TRUE)
    ON CONFLICT (ticker) DO UPDATE SET
      company_name = EXCLUDED.company_name,
      nse_symbol = EXCLUDED.nse_symbol,
      market_cap_cr = COALESCE(EXCLUDED.market_cap_cr, companies.market_cap_cr),
      face_value = COALESCE(EXCLUDED.face_value, companies.face_value),
      updated_at = NOW()
    RETURNING id`,
    [
      parsed.ticker,
      parsed.companyName,
      parsed.ticker,
      parsed.marketCapCr,
      parsed.faceValue,
    ]
  );

  const companyId = Number(companyResult.rows[0].id);
  let insertedAnnual = 0;
  let upsertedRatios = 0;

  for (let i = 0; i < parsed.annualRows.length; i++) {
    const row = parsed.annualRows[i];
    const prev = i > 0 ? parsed.annualRows[i - 1] : null;

    await db.query(
      `INSERT INTO financials_annual (
        company_id, fiscal_year, period_end_date, revenue, expenses, operating_profit,
        other_income, depreciation, interest_expense, profit_before_tax, tax_expense,
        net_profit, eps, equity_capital, reserves, total_borrowings, other_liabilities,
        fixed_assets, cwip, investments, other_assets, total_assets, operating_cash_flow,
        investing_cash_flow, financing_cash_flow, net_cash_flow, capex, is_consolidated, data_source
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23,
        $24,$25,$26,$27,TRUE,'excel_import'
      )
      ON CONFLICT (company_id, fiscal_year, is_consolidated) DO UPDATE SET
        period_end_date = EXCLUDED.period_end_date,
        revenue = EXCLUDED.revenue,
        expenses = EXCLUDED.expenses,
        operating_profit = EXCLUDED.operating_profit,
        other_income = EXCLUDED.other_income,
        depreciation = EXCLUDED.depreciation,
        interest_expense = EXCLUDED.interest_expense,
        profit_before_tax = EXCLUDED.profit_before_tax,
        tax_expense = EXCLUDED.tax_expense,
        net_profit = EXCLUDED.net_profit,
        eps = EXCLUDED.eps,
        equity_capital = EXCLUDED.equity_capital,
        reserves = EXCLUDED.reserves,
        total_borrowings = EXCLUDED.total_borrowings,
        other_liabilities = EXCLUDED.other_liabilities,
        fixed_assets = EXCLUDED.fixed_assets,
        cwip = EXCLUDED.cwip,
        investments = EXCLUDED.investments,
        other_assets = EXCLUDED.other_assets,
        total_assets = EXCLUDED.total_assets,
        operating_cash_flow = EXCLUDED.operating_cash_flow,
        investing_cash_flow = EXCLUDED.investing_cash_flow,
        financing_cash_flow = EXCLUDED.financing_cash_flow,
        net_cash_flow = EXCLUDED.net_cash_flow,
        capex = EXCLUDED.capex,
        data_source = EXCLUDED.data_source`,
      [
        companyId,
        row.fiscalYear,
        row.periodEndDate,
        row.revenue,
        row.expenses,
        row.operatingProfit,
        row.otherIncome,
        row.depreciation,
        row.interestExpense,
        row.profitBeforeTax,
        row.taxExpense,
        row.netProfit,
        row.eps,
        row.equityCapital,
        row.reserves,
        row.totalBorrowings,
        row.otherLiabilities,
        row.fixedAssets,
        row.cwip,
        row.investments,
        row.otherAssets,
        row.totalAssets,
        row.operatingCashFlow,
        row.investingCashFlow,
        row.financingCashFlow,
        row.netCashFlow,
        null,
      ]
    );
    insertedAnnual++;

    const equityBase = (row.equityCapital ?? 0) + (row.reserves ?? 0);
    const debt = row.totalBorrowings ?? null;
    const operatingMargin = row.operatingProfit !== null && row.revenue ? row.operatingProfit / row.revenue : null;
    const netMargin = row.netProfit !== null && row.revenue ? row.netProfit / row.revenue : null;
    const roe = row.netProfit !== null && equityBase > 0 ? row.netProfit / equityBase : null;
    const roce = row.operatingProfit !== null && (equityBase + (row.totalBorrowings ?? 0)) > 0
      ? row.operatingProfit / (equityBase + (row.totalBorrowings ?? 0))
      : null;
    const debtToEquity = debt !== null && equityBase > 0 ? debt / equityBase : null;
    const assetTurnover = row.revenue !== null && (row.totalAssets ?? 0) > 0 ? row.revenue / (row.totalAssets ?? 0) : null;
    const interestCoverage = row.operatingProfit !== null && (row.interestExpense ?? 0) > 0
      ? row.operatingProfit / (row.interestExpense ?? 0)
      : null;
    const pe = row.price !== null && row.eps !== null && row.eps > 0 ? row.price / row.eps : null;
    const pb = row.price !== null && row.bookValuePerShare !== null && row.bookValuePerShare > 0
      ? row.price / row.bookValuePerShare
      : null;
    const earningsYield = pe !== null && pe > 0 ? 1 / pe : null;
    const fcf = row.operatingCashFlow !== null && row.investingCashFlow !== null
      ? row.operatingCashFlow + row.investingCashFlow
      : null;
    const fcfYield = fcf !== null && parsed.marketCapCr && parsed.marketCapCr > 0
      ? fcf / parsed.marketCapCr
      : null;

    await db.query(
      `INSERT INTO ratios (
        company_id, fiscal_year, pe_ratio, pb_ratio, earnings_yield, roe, roce,
        operating_margin, net_margin, debt_to_equity, interest_coverage,
        asset_turnover, revenue_growth_yoy, profit_growth_yoy, eps_growth_yoy,
        fcf, fcf_yield, book_value_per_share
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,
        $12,$13,$14,$15,
        $16,$17,$18
      )
      ON CONFLICT (company_id, fiscal_year) DO UPDATE SET
        pe_ratio = EXCLUDED.pe_ratio,
        pb_ratio = EXCLUDED.pb_ratio,
        earnings_yield = EXCLUDED.earnings_yield,
        roe = EXCLUDED.roe,
        roce = EXCLUDED.roce,
        operating_margin = EXCLUDED.operating_margin,
        net_margin = EXCLUDED.net_margin,
        debt_to_equity = EXCLUDED.debt_to_equity,
        interest_coverage = EXCLUDED.interest_coverage,
        asset_turnover = EXCLUDED.asset_turnover,
        revenue_growth_yoy = EXCLUDED.revenue_growth_yoy,
        profit_growth_yoy = EXCLUDED.profit_growth_yoy,
        eps_growth_yoy = EXCLUDED.eps_growth_yoy,
        fcf = EXCLUDED.fcf,
        fcf_yield = EXCLUDED.fcf_yield,
        book_value_per_share = EXCLUDED.book_value_per_share`,
      [
        companyId,
        row.fiscalYear,
        pe,
        pb,
        earningsYield,
        roe,
        roce,
        operatingMargin,
        netMargin,
        debtToEquity,
        interestCoverage,
        assetTurnover,
        growthYoY(row.revenue, prev?.revenue ?? null),
        growthYoY(row.netProfit, prev?.netProfit ?? null),
        growthYoY(row.eps, prev?.eps ?? null),
        fcf,
        fcfYield,
        row.bookValuePerShare,
      ]
    );
    upsertedRatios++;
  }

  return { insertedAnnual, upsertedRatios };
}

async function main(): Promise<void> {
  await runMigrations();

  const baseDir = path.resolve(process.cwd(), 'data', 'imports', 'companies');
  if (!fs.existsSync(baseDir)) {
    throw new Error(`Import directory not found: ${baseDir}`);
  }

  const files = fs
    .readdirSync(baseDir)
    .filter((f) => /\.(xlsx|xls)$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No Excel files found in ${baseDir}`);
  }

  logger.info({ directory: baseDir, fileCount: files.length }, 'Starting Excel import');

  let importedCompanies = 0;
  let annualRows = 0;
  let ratioRows = 0;
  let skippedFiles = 0;
  const failures: string[] = [];

  for (const file of files) {
    const filePath = path.join(baseDir, file);
    try {
      const parsed = parseWorkbook(filePath);
      if (!parsed) {
        skippedFiles++;
        logger.warn({ file }, 'Skipping unsupported workbook layout');
        continue;
      }

      const stats = await upsertCompanyAndFinancials(parsed);
      importedCompanies++;
      annualRows += stats.insertedAnnual;
      ratioRows += stats.upsertedRatios;
      logger.info({ file, ticker: parsed.ticker, years: parsed.annualRows.length }, 'Imported company workbook');
    } catch (error) {
      const msg = `${file}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(msg);
      logger.error({ file, err: error }, 'Workbook import failed');
    }
  }

  const db = getPool();
  const companyCount = await db.query('SELECT COUNT(*)::int AS count FROM companies');
  const annualCount = await db.query('SELECT COUNT(*)::int AS count FROM financials_annual');
  const ratioCount = await db.query('SELECT COUNT(*)::int AS count FROM ratios');

  logger.info(
    {
      importedCompanies,
      annualRows,
      ratioRows,
      skippedFiles,
      failures: failures.length,
      totals: {
        companies: companyCount.rows[0].count,
        financials_annual: annualCount.rows[0].count,
        ratios: ratioCount.rows[0].count,
      },
      sampleFailures: failures.slice(0, 5),
    },
    'Company Excel import complete'
  );
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Company import failed');
    process.exit(1);
  })
  .finally(async () => {
    await closePool();
  });
