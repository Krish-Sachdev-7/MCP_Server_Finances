import type { Pool } from '../db/connection.js';
import { rootLogger } from '../middleware/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  fetchJson,
  fetchText,
  parseCSV,
  rateLimitedWait,
  safeNum,
  chunk,
} from './utils.js';
import type { IngestResult } from './runner.js';

const logger = rootLogger.child({ module: 'ingestion:companies' });

// Rate limiting is handled via rateLimitedWait('nseindia.com', 5) and rateLimitedWait('bseindia.com', 3)

// NSE and BSE API endpoints
const NSE_BHAVCOPY_URL = 'https://www.nseindia.com/api/equity-stockIndices?index=SECURITIES%20IN%20F%26O';
const NSE_INDEX_ENDPOINTS = {
  NIFTY_50: 'https://www.nseindia.com/api/index-constituents?index=NIFTY%2050',
  NIFTY_NEXT_50: 'https://www.nseindia.com/api/index-constituents?index=NIFTY%20NEXT%2050',
  NIFTY_BANK: 'https://www.nseindia.com/api/index-constituents?index=NIFTY%20BANK',
  NIFTY_IT: 'https://www.nseindia.com/api/index-constituents?index=NIFTY%20IT',
  NIFTY_PHARMA: 'https://www.nseindia.com/api/index-constituents?index=NIFTY%20PHARMA',
};
const BSE_LISTING_URL = 'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w';
const ENABLE_LEGACY_INDEX_CONSTITUENTS = false;

// Interface for raw equity data
interface RawEquityData {
  ticker: string;
  companyName: string;
  isin?: string;
  bseCode?: string;
  nseSymbol?: string;
  sector?: string;
  industry?: string;
  marketCapCr?: number;
  listingDate?: string;
  faceValue?: number;
  exchange?: string;
}

interface IndexConstituent {
  ticker: string;
  indexName: string;
  weight?: number;
  symbol?: string;
}

interface YahooChartQuoteResponse {
  chart?: {
    result?: Array<{
      meta?: {
        longName?: string;
        shortName?: string;
        regularMarketPrice?: number;
      };
    }>;
  };
}

interface NSEResponse {
  data?: Array<{
    symbol: string;
    isinCode: string;
    companyName?: string;
    name?: string;
    sector?: string;
    industryGroup?: string;
    industry?: string;
    subGroup?: string;
    marketCap?: number | string;
    listingDate?: string;
    faceValue?: number | string;
  }>;
  records?: Array<{
    symbol: string;
    isinCode: string;
    companyName?: string;
    name?: string;
    sector?: string;
    industryGroup?: string;
    industry?: string;
    subGroup?: string;
    marketCap?: number | string;
    listingDate?: string;
    faceValue?: number | string;
  }>;
  [key: string]: unknown;
}

interface NSEIndexResponse {
  constituents?: Array<{
    symbol: string;
    [key: string]: unknown;
  }>;
  data?: Array<{
    symbol: string;
    [key: string]: unknown;
  }>;
  records?: Array<{
    symbol: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Fetch equity data from NSE's market data API
 */
// Preserved for future use — original NSE/BSE scraper, replaced by Yahoo Finance primary path (see Risk 1 in SKILL.md)
async function _fetchFromNSEPrimary(): Promise<RawEquityData[]> {
  const records: RawEquityData[] = [];

  try {
    logger.info('Fetching NSE primary source...');

    // Try fetching from NSE bhavcopy/equity endpoint
    const response = await fetchJson(NSE_BHAVCOPY_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }) as NSEResponse;

    // Parse NSE response - structure may vary, handle gracefully
    if (response && typeof response === 'object') {
      const data = Array.isArray(response) ? response : response.data || response.records || [];

      for (const item of data) {
        if (!item.symbol || !item.isinCode) continue;

        try {
          records.push({
            ticker: item.symbol.trim(),
            companyName: item.companyName || item.name || item.symbol,
            isin: item.isinCode.trim(),
            sector: item.sector || item.industryGroup,
            industry: item.industry || item.subGroup,
            marketCapCr: safeNum(item.marketCap) ?? undefined,
            listingDate: item.listingDate,
            faceValue: safeNum(item.faceValue) ?? undefined,
          });
        } catch (err) {
          logger.debug({ symbol: item.symbol, error: String(err) }, 'Error parsing NSE record');
        }

        await rateLimitedWait('nseindia.com', 5);
      }
    }

    logger.info({ recordCount: records.length }, 'NSE primary fetch completed');
    return records;
  } catch (error) {
    logger.warn({ error: String(error) }, 'NSE primary fetch failed, will fall back to BSE');
    return [];
  }
}

/**
 * Fetch equity data from BSE listing CSV
 */
// Preserved for future use — original NSE/BSE scraper, replaced by Yahoo Finance primary path (see Risk 1 in SKILL.md)
async function _fetchFromBSEFallback(): Promise<RawEquityData[]> {
  const records: RawEquityData[] = [];

  try {
    logger.info('Fetching BSE fallback source...');

    const csvText = await fetchText(BSE_LISTING_URL, {
      headers: {
        'Accept': 'text/csv, application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const rows = parseCSV(csvText);

    for (const row of rows) {
      if (!row.ScripCode && !row.ScripSymbol) continue;

      try {
        // BSE CSV column names may vary, handle multiple possibilities
        const ticker = (row.ScripSymbol || row.SYMBOL || row.Symbol || '').trim();
        const isin = (row.ISIN || row.isinCode || '').trim();

        if (!ticker || !isin) continue;

        records.push({
          ticker,
          companyName: row.ScripName || row.CompanyName || row.Name || ticker,
          isin,
          sector: row.Sector || row.IndustryGroup,
          industry: row.Industry || row.SubGroup,
          marketCapCr: safeNum(row.MarketCap) ?? undefined,
          listingDate: row.ListingDate,
          faceValue: safeNum(row.FaceValue) ?? undefined,
        });
      } catch (err) {
        logger.debug({ row, error: String(err) }, 'Error parsing BSE record');
      }

      await rateLimitedWait('bseindia.com', 3);
    }

    logger.info({ recordCount: records.length }, 'BSE fallback fetch completed');
    return records;
  } catch (error) {
    logger.error({ error: String(error) }, 'BSE fallback fetch failed');
    return [];
  }
}

void _fetchFromNSEPrimary;
void _fetchFromBSEFallback;

/**
 * Fetch index constituents from NSE index API
 */
async function fetchIndexConstituents(): Promise<IndexConstituent[]> {
  const constituents: IndexConstituent[] = [];

  for (const [indexKey, endpoint] of Object.entries(NSE_INDEX_ENDPOINTS)) {
    try {
      logger.debug({ index: indexKey }, 'Fetching index constituents');

      const response = await fetchJson(endpoint, {
        headers: {
          'Accept': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }) as NSEIndexResponse;

      if (response && typeof response === 'object') {
        const data = response.constituents || response.data || response.records || [];

        for (const item of data) {
          if (!item.symbol) continue;

          try {
            constituents.push({
              ticker: item.symbol.trim(),
              indexName: indexKey,
              symbol: item.symbol.trim(),
            });
          } catch (err) {
            logger.debug({ symbol: item.symbol, error: String(err) }, 'Error parsing index constituent');
          }
        }
      }

      await rateLimitedWait('nseindia.com', 5);
    } catch (error) {
      logger.warn({ index: indexKey, error: String(error) }, 'Failed to fetch index constituents');
    }
  }

  logger.info({ constituentsCount: constituents.length }, 'Index constituents fetch completed');
  return constituents;
}

/**
 * Deduplicate companies by ISIN, keeping the first occurrence
 */
function dedupByISIN(companies: RawEquityData[]): RawEquityData[] {
  const seen = new Set<string>();
  const deduped: RawEquityData[] = [];

  for (const company of companies) {
    if (!company.isin) {
      deduped.push(company);
      continue;
    }

    if (!seen.has(company.isin)) {
      seen.add(company.isin);
      deduped.push(company);
    }
  }

  return deduped;
}

function dedupByTicker(companies: RawEquityData[]): RawEquityData[] {
  const seen = new Set<string>();
  const deduped: RawEquityData[] = [];

  for (const company of companies) {
    const ticker = company.ticker.trim().toUpperCase();
    if (!ticker || seen.has(ticker)) {
      continue;
    }
    seen.add(ticker);
    deduped.push({ ...company, ticker });
  }

  return deduped;
}

async function loadCompaniesFromSeedCSV(): Promise<RawEquityData[]> {
  const csvPath = path.resolve(process.cwd(), 'data', 'seeds', 'companies_seed.csv');
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Seed CSV not found at ${csvPath}`);
  }

  const csvText = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCSV(csvText);

  const companies: RawEquityData[] = [];
  for (const row of rows) {
    const ticker = (row.ticker || row.nse_symbol || '').trim().toUpperCase();
    if (!ticker) continue;

    companies.push({
      ticker,
      companyName: (row.company_name || ticker).trim(),
      isin: (row.isin || '').trim() || undefined,
      bseCode: (row.bse_code || '').trim() || undefined,
      nseSymbol: (row.nse_symbol || ticker).trim().toUpperCase(),
      sector: (row.sector || '').trim() || undefined,
      industry: (row.industry || '').trim() || undefined,
      marketCapCr: safeNum(row.market_cap_cr) ?? undefined,
      faceValue: safeNum(row.face_value) ?? undefined,
      exchange: (row.exchange || 'NSE').trim() || 'NSE',
    });
  }

  return dedupByTicker(companies);
}

async function enrichCompaniesFromYahoo(companies: RawEquityData[]): Promise<RawEquityData[]> {
  const enriched: RawEquityData[] = [];

  for (const company of companies) {
    const symbol = `${company.nseSymbol || company.ticker}.NS`;
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
    url.searchParams.set('range', '1d');
    url.searchParams.set('interval', '1d');

    try {
      const response = await fetchJson<YahooChartQuoteResponse>(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
      });
      const quoteMeta = response.chart?.result?.[0]?.meta;

      enriched.push({
        ...company,
        companyName: quoteMeta?.longName || quoteMeta?.shortName || company.companyName,
        sector: company.sector,
        industry: company.industry,
        marketCapCr: company.marketCapCr,
      });
    } catch (error) {
      logger.warn({ ticker: company.ticker, error: String(error) }, 'Yahoo enrichment failed, keeping seed baseline');
      enriched.push(company);
    }

    await rateLimitedWait('query1.finance.yahoo.com', 3);
  }

  return enriched;
}

/**
 * Upsert companies into the database with idempotent ON CONFLICT DO UPDATE
 */
async function upsertCompanies(
  db: Pool,
  companies: RawEquityData[]
): Promise<{ inserted: number; updated: number; errors: string[] }> {
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  const batchSize = 100;
  const batches = chunk(companies, batchSize);

  for (const batch of batches) {
    try {
      const valuesToInsert = batch
        .map((_c, idx) => {
          const offset = idx * 11;
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`;
        })
        .join(',');

      const params: (string | number | null | undefined)[] = [];
      for (const c of batch) {
        params.push(
          c.ticker,
          c.companyName,
          c.isin || null,
          c.bseCode || null,
          c.nseSymbol || c.ticker,
          c.sector || null,
          c.industry || null,
          c.marketCapCr ?? null,
          c.listingDate || null,
          c.faceValue ?? null,
          c.exchange || 'NSE'
        );
      }

      const query = `
        INSERT INTO companies (
          ticker, company_name, isin, bse_code, nse_symbol,
          sector, industry, market_cap_cr, listing_date, face_value, exchange
        )
        VALUES ${valuesToInsert}
        ON CONFLICT (ticker) DO UPDATE SET
          ticker = EXCLUDED.ticker,
          company_name = EXCLUDED.company_name,
          isin = COALESCE(EXCLUDED.isin, companies.isin),
          bse_code = COALESCE(EXCLUDED.bse_code, companies.bse_code),
          nse_symbol = COALESCE(EXCLUDED.nse_symbol, companies.nse_symbol),
          sector = COALESCE(EXCLUDED.sector, companies.sector),
          industry = COALESCE(EXCLUDED.industry, companies.industry),
          market_cap_cr = COALESCE(EXCLUDED.market_cap_cr, companies.market_cap_cr),
          listing_date = COALESCE(EXCLUDED.listing_date, companies.listing_date),
          face_value = COALESCE(EXCLUDED.face_value, companies.face_value),
          exchange = COALESCE(EXCLUDED.exchange, companies.exchange),
          updated_at = NOW()
        RETURNING xmax;
      `;

      const result = await db.query(query, params);

      if (result && result.rows) {
        // xmax = 0 means INSERT, xmax > 0 means UPDATE
        for (const row of result.rows) {
          if (row.xmax === 0 || row.xmax === '0') {
            inserted++;
          } else {
            updated++;
          }
        }
      }
    } catch (error) {
      const errorMsg = `Batch upsert error: ${String(error)}`;
      logger.error({ error: String(error), batchSize: batch.length }, errorMsg);
      errors.push(errorMsg);
    }
  }

  return { inserted, updated, errors };
}

/**
 * Upsert index constituents into the database
 */
async function upsertIndexConstituents(
  db: Pool,
  constituents: IndexConstituent[]
): Promise<{ inserted: number; updated: number; errors: string[] }> {
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  const batchSize = 100;
  const batches = chunk(constituents, batchSize);

  for (const batch of batches) {
    try {
      const valuesToInsert = batch
        .map((_c, idx) => {
          const offset = idx * 3;
          return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
        })
        .join(',');

      const params: Array<string | number | null> = [];
      for (const c of batch) {
        params.push(c.indexName, c.ticker, c.weight ?? null);
      }

      const query = `
        INSERT INTO index_constituents (index_name, company_id, weight, effective_date, is_current)
        SELECT v.index_name, c.id, v.weight, CURRENT_DATE, TRUE
        FROM (VALUES ${valuesToInsert}) AS v(index_name, ticker, weight)
        JOIN companies c ON c.ticker = v.ticker
        ON CONFLICT (index_name, company_id, effective_date) DO UPDATE SET
          weight = COALESCE(EXCLUDED.weight, index_constituents.weight),
          is_current = TRUE
        RETURNING xmax;
      `;

      const result = await db.query(query, params);

      if (result && result.rows) {
        for (const row of result.rows) {
          if (row.xmax === 0 || row.xmax === '0') {
            inserted++;
          } else {
            updated++;
          }
        }
      }
    } catch (error) {
      const errorMsg = `Index constituents batch error: ${String(error)}`;
      logger.error({ error: String(error), batchSize: batch.length }, errorMsg);
      errors.push(errorMsg);
    }
  }

  return { inserted, updated, errors };
}

/**
 * Main pipeline run function
 */
async function run(db: Pool, _options?: { forceNSE?: boolean }): Promise<IngestResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let recordsProcessed = 0;
  let recordsInserted = 0;
  let recordsUpdated = 0;

  try {
    logger.info('Starting companies ingestion pipeline');

    logger.info('Loading baseline company universe from seed CSV');
    let companies = await loadCompaniesFromSeedCSV();

    logger.info({ recordCount: companies.length }, 'Enriching baseline companies with Yahoo Finance quote/profile data');
    companies = await enrichCompaniesFromYahoo(companies);

    // Legacy source path retained as commented fallback for future use (Risk 1: NSE/BSE instability).
    // let companies = await fetchFromNSEPrimary();
    // if (companies.length === 0) {
    //   logger.info('Primary source returned no data, falling back to BSE');
    //   companies = await fetchFromBSEFallback();
    // }

    if (companies.length === 0) {
      logger.error('CSV baseline + Yahoo enrichment returned no company data');
      errors.push('No company data retrieved from seed CSV + Yahoo enrichment');
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors,
        durationMs: Date.now() - startTime,
      };
    }

    logger.info({ recordCount: companies.length }, 'Deduplicating companies by ticker and ISIN');
    companies = dedupByISIN(dedupByTicker(companies));
    recordsProcessed = companies.length;

    // Upsert companies
    logger.info('Upserting companies into database');
    const companyResult = await upsertCompanies(db, companies);
    recordsInserted = companyResult.inserted;
    recordsUpdated = companyResult.updated;
    errors.push(...companyResult.errors);

    logger.info(
      { inserted: recordsInserted, updated: recordsUpdated },
      'Companies upserted successfully'
    );

    // Index constituent scraping from NSE is intentionally disabled due endpoint instability.
    if (ENABLE_LEGACY_INDEX_CONSTITUENTS) {
      const constituents = await fetchIndexConstituents();
      if (constituents.length > 0) {
        await upsertIndexConstituents(db, constituents);
      }
    }

    const durationMs = Date.now() - startTime;
    logger.info(
      {
        recordsProcessed,
        recordsInserted,
        recordsUpdated,
        errorCount: errors.length,
        durationMs,
      },
      'Companies ingestion pipeline completed'
    );

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated,
      errors,
      durationMs,
    };
  } catch (error) {
    const errorMsg = `Unexpected error in companies pipeline: ${String(error)}`;
    logger.error({ error: String(error) }, errorMsg);
    errors.push(errorMsg);

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated,
      errors,
      durationMs: Date.now() - startTime,
    };
  }
}

export { run };
export const name = 'companies';
export const schedule = '0 6 * * 0'; // Sundays at 6 AM
