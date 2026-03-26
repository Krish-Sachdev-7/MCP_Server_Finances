/**
 * Seed script -- loads sample data for development and testing.
 * Creates 20 representative companies across sectors with 5 years of data
 * covering all data domains: financials, prices, shareholding, corporate actions,
 * insider trades, and macro indicators.
 *
 * Usage: npm run seed
 *
 * This allows development and testing without hitting external APIs.
 * Real data comes from Phase 2 ingestion pipelines.
 */

import 'dotenv/config';
import { getPool, closePool } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { pino } from 'pino';

const logger = pino({ name: 'seed' });

// Representative sample of Indian companies across sectors
const SEED_COMPANIES = [
  { ticker: 'RELIANCE', name: 'Reliance Industries Limited', sector: 'Energy', industry: 'Oil & Gas - Refining & Marketing', mcap: 1900000, isin: 'INE002A01018' },
  { ticker: 'TCS', name: 'Tata Consultancy Services Limited', sector: 'Information Technology', industry: 'IT - Software', mcap: 1500000, isin: 'INE467B01029' },
  { ticker: 'HDFCBANK', name: 'HDFC Bank Limited', sector: 'Financial Services', industry: 'Banks', mcap: 1350000, isin: 'INE040A01034' },
  { ticker: 'INFY', name: 'Infosys Limited', sector: 'Information Technology', industry: 'IT - Software', mcap: 750000, isin: 'INE009A01021' },
  { ticker: 'ICICIBANK', name: 'ICICI Bank Limited', sector: 'Financial Services', industry: 'Banks', mcap: 900000, isin: 'INE090A01021' },
  { ticker: 'HINDUNILVR', name: 'Hindustan Unilever Limited', sector: 'FMCG', industry: 'FMCG', mcap: 600000, isin: 'INE030A01027' },
  { ticker: 'ITC', name: 'ITC Limited', sector: 'FMCG', industry: 'Cigarettes & Tobacco Products', mcap: 550000, isin: 'INE154A01025' },
  { ticker: 'SBIN', name: 'State Bank of India', sector: 'Financial Services', industry: 'Banks', mcap: 700000, isin: 'INE062A01020' },
  { ticker: 'BHARTIARTL', name: 'Bharti Airtel Limited', sector: 'Telecommunication', industry: 'Telecom - Cellular & Fixed line services', mcap: 850000, isin: 'INE397D01024' },
  { ticker: 'KOTAKBANK', name: 'Kotak Mahindra Bank Limited', sector: 'Financial Services', industry: 'Banks', mcap: 400000, isin: 'INE237A01028' },
  { ticker: 'LT', name: 'Larsen & Toubro Limited', sector: 'Construction', industry: 'Engineering - Construction', mcap: 500000, isin: 'INE018A01030' },
  { ticker: 'HCLTECH', name: 'HCL Technologies Limited', sector: 'Information Technology', industry: 'IT - Software', mcap: 450000, isin: 'INE860A01027' },
  { ticker: 'ASIANPAINT', name: 'Asian Paints Limited', sector: 'Consumer Durables', industry: 'Paints', mcap: 300000, isin: 'INE021A01026' },
  { ticker: 'MARUTI', name: 'Maruti Suzuki India Limited', sector: 'Automobile', industry: 'Automobiles', mcap: 380000, isin: 'INE585B01010' },
  { ticker: 'SUNPHARMA', name: 'Sun Pharmaceutical Industries Limited', sector: 'Healthcare', industry: 'Pharmaceuticals', mcap: 420000, isin: 'INE044A01036' },
  { ticker: 'TATAMOTORS', name: 'Tata Motors Limited', sector: 'Automobile', industry: 'Automobiles', mcap: 300000, isin: 'INE155A01022' },
  { ticker: 'WIPRO', name: 'Wipro Limited', sector: 'Information Technology', industry: 'IT - Software', mcap: 280000, isin: 'INE075A01022' },
  { ticker: 'TITAN', name: 'Titan Company Limited', sector: 'Consumer Durables', industry: 'Diamond & Jewellery', mcap: 320000, isin: 'INE280A01028' },
  { ticker: 'ULTRACEMCO', name: 'UltraTech Cement Limited', sector: 'Construction Materials', industry: 'Cement', mcap: 310000, isin: 'INE481G01011' },
  { ticker: 'BAJFINANCE', name: 'Bajaj Finance Limited', sector: 'Financial Services', industry: 'Non Banking Financial Company (NBFC)', mcap: 450000, isin: 'INE296A01024' },
];

// ============================================================
// SEEDER FUNCTIONS
// ============================================================

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function roundTo(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function formatDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

async function seedCompanies(db: import('pg').Pool): Promise<void> {
  logger.info('Seeding companies...');

  for (const company of SEED_COMPANIES) {
    await db.query(
      `INSERT INTO companies (ticker, company_name, isin, sector, industry, market_cap_cr, exchange, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, 'NSE', TRUE)
       ON CONFLICT (isin) DO UPDATE SET
         market_cap_cr = EXCLUDED.market_cap_cr,
         updated_at = NOW()`,
      [company.ticker, company.name, company.isin, company.sector, company.industry, company.mcap]
    );
  }

  logger.info({ count: SEED_COMPANIES.length }, 'Companies seeded');
}

async function seedFinancials(db: import('pg').Pool): Promise<void> {
  logger.info('Seeding financial data...');

  const { rows: companies } = await db.query('SELECT id, ticker, market_cap_cr FROM companies');

  for (const company of companies) {
    const baseRevenue = company.market_cap_cr * 0.3;
    const baseProfit = baseRevenue * 0.15;

    for (let year = 2020; year <= 2024; year++) {
      const growthFactor = 1 + (year - 2020) * 0.08 + rand(-0.05, 0.05);
      const revenue = Math.round(baseRevenue * growthFactor);
      const netProfit = Math.round(baseProfit * growthFactor * rand(0.9, 1.1));
      const operatingProfit = Math.round(netProfit * 1.3);
      const totalAssets = Math.round(revenue * 2.5);
      const equity = Math.round(totalAssets * 0.4);
      const borrowings = Math.round(totalAssets * 0.2);
      const otherIncome = Math.round(revenue * 0.03);
      const depreciation = Math.round(totalAssets * 0.04);
      const interestExpense = Math.round(borrowings * 0.08);
      const pbt = netProfit + Math.round(netProfit * 0.25);
      const taxExpense = pbt - netProfit;
      const ocf = Math.round(netProfit * 1.1);
      const icf = Math.round(-totalAssets * 0.05);
      const fcf = Math.round(-borrowings * 0.03);

      await db.query(
        `INSERT INTO financials_annual
         (company_id, fiscal_year, revenue, net_profit, operating_profit,
          other_income, depreciation, interest_expense, profit_before_tax,
          tax_expense, equity_capital, reserves, total_borrowings, total_assets,
          operating_cash_flow, investing_cash_flow, financing_cash_flow,
          eps, is_consolidated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, TRUE)
         ON CONFLICT (company_id, fiscal_year, is_consolidated) DO NOTHING`,
        [
          company.id, year, revenue, netProfit, operatingProfit,
          otherIncome, depreciation, interestExpense, pbt,
          taxExpense, Math.round(equity * 0.1), equity, borrowings, totalAssets,
          ocf, icf, fcf,
          Math.round(netProfit / (company.market_cap_cr * 0.001)),
        ]
      );

      // Seed quarterly data (4 quarters per year)
      for (let q = 1; q <= 4; q++) {
        const qRevenue = Math.round(revenue / 4 * rand(0.85, 1.15));
        const qProfit = Math.round(netProfit / 4 * rand(0.8, 1.2));
        const qMonth = q * 3;
        const periodEnd = `${year}-${String(qMonth).padStart(2, '0')}-${qMonth === 3 || qMonth === 12 ? '31' : '30'}`;

        await db.query(
          `INSERT INTO financials_quarterly
           (company_id, fiscal_year, quarter, period_end_date, revenue, net_profit,
            operating_profit, eps, is_consolidated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
           ON CONFLICT (company_id, fiscal_year, quarter, is_consolidated) DO NOTHING`,
          [
            company.id, year, q, periodEnd, qRevenue, qProfit,
            Math.round(qProfit * 1.3),
            Math.round(qProfit / (company.market_cap_cr * 0.001)),
          ]
        );
      }

      // Seed ratios
      const pe = company.market_cap_cr / Math.max(netProfit, 1);
      const roe = netProfit / Math.max(equity, 1);
      const roce = operatingProfit / Math.max(equity + borrowings, 1);

      await db.query(
        `INSERT INTO ratios
         (company_id, fiscal_year, pe_ratio, pb_ratio, roe, roce,
          debt_to_equity, operating_margin, net_margin,
          revenue_growth_yoy, profit_growth_yoy, piotroski_score,
          fcf, book_value_per_share)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (company_id, fiscal_year) DO NOTHING`,
        [
          company.id, year,
          roundTo(pe, 2),
          roundTo(pe * 0.4, 2),
          roundTo(roe, 4),
          roundTo(roce, 4),
          roundTo(borrowings / Math.max(equity, 1), 2),
          roundTo(operatingProfit / Math.max(revenue, 1), 4),
          roundTo(netProfit / Math.max(revenue, 1), 4),
          roundTo(rand(0.03, 0.18), 4),
          roundTo(rand(0.01, 0.18), 4),
          Math.floor(rand(3, 9)),
          Math.round(ocf - totalAssets * 0.05),
          roundTo(equity / (company.market_cap_cr * 0.001), 2),
        ]
      );
    }
  }

  logger.info('Financial data seeded');
}

async function seedPriceHistory(db: import('pg').Pool): Promise<void> {
  logger.info('Seeding price history (1 year of daily data)...');

  const { rows: companies } = await db.query('SELECT id, ticker, market_cap_cr FROM companies');

  for (const company of companies) {
    // Generate a base price proportional to market cap
    let price = Math.round(company.market_cap_cr / 1000 * rand(0.8, 1.5));
    const today = new Date();

    for (let daysBack = 365; daysBack >= 0; daysBack--) {
      const d = new Date(today);
      d.setDate(d.getDate() - daysBack);

      // Skip weekends
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue;

      // Random walk for price
      const change = price * rand(-0.03, 0.03);
      price = Math.max(price + change, 10);

      const open = roundTo(price * rand(0.99, 1.01), 2);
      const close = roundTo(price, 2);
      const high = roundTo(Math.max(open, close) * rand(1.0, 1.02), 2);
      const low = roundTo(Math.min(open, close) * rand(0.98, 1.0), 2);
      const volume = Math.round(rand(100000, 10000000));

      await db.query(
        `INSERT INTO price_history (company_id, trade_date, open_price, high_price, low_price, close_price, adj_close, volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (company_id, trade_date) DO NOTHING`,
        [company.id, formatDateStr(d), open, high, low, close, close, volume]
      );
    }
  }

  logger.info('Price history seeded');
}

async function seedShareholdingPatterns(db: import('pg').Pool): Promise<void> {
  logger.info('Seeding shareholding patterns...');

  const { rows: companies } = await db.query('SELECT id, ticker FROM companies');

  for (const company of companies) {
    // Generate 8 quarters of shareholding data
    for (let qBack = 7; qBack >= 0; qBack--) {
      const d = new Date();
      d.setMonth(d.getMonth() - qBack * 3);
      // Set to quarter-end date
      const qMonth = Math.floor(d.getMonth() / 3) * 3 + 2;
      d.setMonth(qMonth);
      d.setDate(qMonth === 2 || qMonth === 5 || qMonth === 8 || qMonth === 11 ? 30 : 31);
      if (qMonth === 2) d.setDate(28); // February

      const promoter = roundTo(rand(30, 75), 4);
      const fii = roundTo(rand(5, 30), 4);
      const dii = roundTo(rand(5, 25), 4);
      const pub = roundTo(100 - promoter - fii - dii, 4);
      const pledged = roundTo(rand(0, 10), 4);

      await db.query(
        `INSERT INTO shareholding_patterns
         (company_id, quarter_end_date, promoter_holding, fii_holding, dii_holding,
          public_holding, pledged_percentage, total_shares)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (company_id, quarter_end_date) DO NOTHING`,
        [
          company.id, formatDateStr(d),
          promoter / 100, fii / 100, dii / 100, pub / 100, pledged / 100,
          Math.round(company.market_cap_cr ?? 100000) * 10000, // rough share count
        ]
      );
    }
  }

  logger.info('Shareholding patterns seeded');
}

async function seedCorporateActions(db: import('pg').Pool): Promise<void> {
  logger.info('Seeding corporate actions...');

  const { rows: companies } = await db.query('SELECT id, ticker FROM companies');
  const actionTypes = ['dividend', 'split', 'bonus', 'buyback'];

  for (const company of companies) {
    // 2-5 corporate actions per company over 5 years
    const numActions = Math.floor(rand(2, 6));
    for (let i = 0; i < numActions; i++) {
      const actionType = actionTypes[Math.floor(rand(0, actionTypes.length))];
      const daysAgo = Math.floor(rand(30, 1800));
      const exDate = new Date();
      exDate.setDate(exDate.getDate() - daysAgo);
      const recordDate = new Date(exDate);
      recordDate.setDate(recordDate.getDate() + 5);

      let value: number;
      let details: string;
      switch (actionType) {
        case 'dividend':
          value = roundTo(rand(2, 50), 2);
          details = `Dividend of Rs. ${value} per share`;
          break;
        case 'split':
          value = rand(0.3, 0.8) > 0.5 ? 0.5 : 0.2; // 1:2 or 1:5 split
          details = value === 0.5 ? 'Stock split from Rs.10 to Rs.5' : 'Stock split from Rs.10 to Rs.2';
          break;
        case 'bonus':
          value = rand(0.3, 0.8) > 0.5 ? 1 : 2; // 1:1 or 2:1
          details = value === 1 ? 'Bonus 1:1' : 'Bonus 2:1';
          break;
        default:
          value = roundTo(rand(100, 5000), 2);
          details = `Buyback at Rs. ${value} per share`;
      }

      await db.query(
        `INSERT INTO corporate_actions (company_id, action_type, ex_date, record_date, details, value)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [company.id, actionType, formatDateStr(exDate), formatDateStr(recordDate), details, value]
      );
    }
  }

  logger.info('Corporate actions seeded');
}

async function seedInsiderTrades(db: import('pg').Pool): Promise<void> {
  logger.info('Seeding insider trades...');

  const { rows: companies } = await db.query('SELECT id, ticker FROM companies');
  const relationships = ['Promoter', 'Promoter Group', 'Key Managerial Personnel', 'Director'];

  for (const company of companies) {
    // 3-8 insider trades per company over the last year
    const numTrades = Math.floor(rand(3, 9));
    for (let i = 0; i < numTrades; i++) {
      const daysAgo = Math.floor(rand(1, 365));
      const tradeDate = new Date();
      tradeDate.setDate(tradeDate.getDate() - daysAgo);
      const disclosureDate = new Date(tradeDate);
      disclosureDate.setDate(disclosureDate.getDate() + Math.floor(rand(1, 5)));

      const txType = rand(0, 1) > 0.4 ? 'buy' : 'sell';
      const shares = Math.round(rand(1000, 500000));
      const pricePerShare = company.market_cap_cr ?? 100000 / 1000;
      const valueCr = roundTo((shares * pricePerShare) / 10000000, 4);
      const relationship = relationships[Math.floor(rand(0, relationships.length))];

      await db.query(
        `INSERT INTO insider_trades
         (company_id, insider_name, relationship, transaction_type, shares, value_cr, trade_date, disclosure_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          company.id,
          `${relationship} of ${company.ticker}`,
          relationship,
          txType,
          shares,
          valueCr,
          formatDateStr(tradeDate),
          formatDateStr(disclosureDate),
        ]
      );
    }
  }

  logger.info('Insider trades seeded');
}

async function seedMacroIndicators(db: import('pg').Pool): Promise<void> {
  logger.info('Seeding macro indicators...');

  // 24 months of macro data
  for (let monthsBack = 23; monthsBack >= 0; monthsBack--) {
    const d = new Date();
    d.setMonth(d.getMonth() - monthsBack);
    d.setDate(1);

    const repoRate = roundTo(rand(4.0, 6.5), 4);
    const cpi = roundTo(rand(3.5, 7.5), 2);

    await db.query(
      `INSERT INTO macro_indicators
       (indicator_date, repo_rate, reverse_repo_rate, cpi_inflation, wpi_inflation,
        gdp_growth, iip_growth, pmi_manufacturing, pmi_services,
        usd_inr_rate, crude_oil_usd, gold_inr_per_10g,
        fii_net_buy_cr, dii_net_buy_cr)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (indicator_date) DO NOTHING`,
      [
        formatDateStr(d),
        repoRate,
        roundTo(repoRate - 0.25, 4),
        cpi,
        roundTo(rand(1.0, 5.0), 2),
        roundTo(rand(4.0, 8.5), 2),
        roundTo(rand(-2.0, 8.0), 2),
        roundTo(rand(48.0, 58.0), 2),
        roundTo(rand(50.0, 60.0), 2),
        roundTo(rand(82.0, 85.0), 4),
        roundTo(rand(65.0, 95.0), 2),
        roundTo(rand(55000, 75000), 2),
        roundTo(rand(-15000, 20000), 2),
        roundTo(rand(-5000, 15000), 2),
      ]
    );
  }

  logger.info('Macro indicators seeded');
}

async function seedIndexConstituents(db: import('pg').Pool): Promise<void> {
  logger.info('Seeding index constituents...');

  const { rows: companies } = await db.query(
    'SELECT id, market_cap_cr FROM companies ORDER BY market_cap_cr DESC NULLS LAST'
  );

  const weight = 100 / Math.min(companies.length, 20);
  for (let i = 0; i < Math.min(companies.length, 20); i++) {
    await db.query(
      `INSERT INTO index_constituents (index_name, company_id, weight, is_current)
       VALUES ('NIFTY 50', $1, $2, TRUE)
       ON CONFLICT DO NOTHING`,
      [companies[i].id, roundTo(weight, 2)]
    );
  }

  // Also seed NIFTY BANK with banking companies
  const { rows: banks } = await db.query(
    "SELECT id FROM companies WHERE industry ILIKE '%bank%' ORDER BY market_cap_cr DESC NULLS LAST"
  );
  const bankWeight = 100 / Math.max(banks.length, 1);
  for (const bank of banks) {
    await db.query(
      `INSERT INTO index_constituents (index_name, company_id, weight, is_current)
       VALUES ('NIFTY BANK', $1, $2, TRUE)
       ON CONFLICT DO NOTHING`,
      [bank.id, roundTo(bankWeight, 2)]
    );
  }

  // Seed NIFTY IT with IT companies
  const { rows: itCompanies } = await db.query(
    "SELECT id FROM companies WHERE sector = 'Information Technology' ORDER BY market_cap_cr DESC NULLS LAST"
  );
  const itWeight = 100 / Math.max(itCompanies.length, 1);
  for (const it of itCompanies) {
    await db.query(
      `INSERT INTO index_constituents (index_name, company_id, weight, is_current)
       VALUES ('NIFTY IT', $1, $2, TRUE)
       ON CONFLICT DO NOTHING`,
      [it.id, roundTo(itWeight, 2)]
    );
  }

  logger.info('Index constituents seeded');
}

async function seedPipelineStatus(db: import('pg').Pool): Promise<void> {
  logger.info('Ensuring pipeline_status rows exist...');

  const pipelines = [
    'companies', 'financials', 'prices', 'shareholding',
    'corporate_actions', 'insider_trades', 'macro_indicators', 'announcements',
  ];

  for (const name of pipelines) {
    await db.query(
      `INSERT INTO pipeline_status (pipeline_name, status)
       VALUES ($1, 'idle')
       ON CONFLICT (pipeline_name) DO NOTHING`,
      [name]
    );
  }

  logger.info('Pipeline status seeded');
}

// ============================================================
// MAIN
// ============================================================

async function seed(): Promise<void> {
  await runMigrations();
  const db = getPool();

  await seedCompanies(db);
  await seedFinancials(db);
  await seedPriceHistory(db);
  await seedShareholdingPatterns(db);
  await seedCorporateActions(db);
  await seedInsiderTrades(db);
  await seedMacroIndicators(db);
  await seedIndexConstituents(db);
  await seedPipelineStatus(db);

  // Print summary
  const counts = await Promise.all([
    db.query('SELECT COUNT(*) as c FROM companies'),
    db.query('SELECT COUNT(*) as c FROM financials_annual'),
    db.query('SELECT COUNT(*) as c FROM financials_quarterly'),
    db.query('SELECT COUNT(*) as c FROM ratios'),
    db.query('SELECT COUNT(*) as c FROM price_history'),
    db.query('SELECT COUNT(*) as c FROM shareholding_patterns'),
    db.query('SELECT COUNT(*) as c FROM corporate_actions'),
    db.query('SELECT COUNT(*) as c FROM insider_trades'),
    db.query('SELECT COUNT(*) as c FROM macro_indicators'),
    db.query('SELECT COUNT(*) as c FROM index_constituents'),
  ]);

  logger.info({
    companies: counts[0].rows[0].c,
    financials_annual: counts[1].rows[0].c,
    financials_quarterly: counts[2].rows[0].c,
    ratios: counts[3].rows[0].c,
    price_history: counts[4].rows[0].c,
    shareholding_patterns: counts[5].rows[0].c,
    corporate_actions: counts[6].rows[0].c,
    insider_trades: counts[7].rows[0].c,
    macro_indicators: counts[8].rows[0].c,
    index_constituents: counts[9].rows[0].c,
  }, 'Seed complete. Row counts:');
}

seed()
  .catch((err) => {
    logger.fatal({ err }, 'Seeding failed');
    process.exit(1);
  })
  .finally(async () => {
    await closePool();
  });
