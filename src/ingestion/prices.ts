import type { Pool } from '../db/connection.js';
import { rootLogger } from '../middleware/logger.js';
import { fetchJson, rateLimitedWait, sleep, chunk, formatDate, daysAgo } from './utils.js';
import type { IngestResult } from './runner.js';

const logger = rootLogger.child({ module: 'ingestion:prices' });

export const name = 'prices';
export const schedule = '0 16 * * 1-5'; // Daily after market close (4 PM IST), Monday-Friday

interface YahooChartResponse {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
        adjclose: Array<{
          adjclose: (number | null)[];
        }>;
      };
    }>;
    error?: {
      code: string;
      description: string;
    };
  };
}

interface PriceRecord {
  companyId: number;
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
}

interface PriceCompany {
  id: number;
  ticker: string;
  nse_symbol: string | null;
}

async function fetchYahooData(symbol: string, startEpoch: number, endEpoch: number): Promise<PriceRecord[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${startEpoch}&period2=${endEpoch}&interval=1d`;

  try {
    const response = await fetchJson<YahooChartResponse>(url);

    if (!response.chart.result || response.chart.result.length === 0) {
      logger.warn({ symbol, url }, 'Empty Yahoo Finance response');
      return [];
    }

    const result = response.chart.result[0];
    if (!result.timestamp || !result.indicators.quote || !result.indicators.adjclose) {
      logger.warn({ symbol }, 'Malformed Yahoo Finance response structure');
      return [];
    }

    const quotes = result.indicators.quote[0];
    const adjCloses = result.indicators.adjclose[0];
    const prices: PriceRecord[] = [];

    for (let i = 0; i < result.timestamp.length; i++) {
      const open = quotes.open?.[i] ?? null;
      const high = quotes.high?.[i] ?? null;
      const low = quotes.low?.[i] ?? null;
      const close = quotes.close?.[i] ?? null;
      const adjClose = adjCloses.adjclose?.[i] ?? null;
      const volume = quotes.volume?.[i] ?? null;

      // Skip records with missing critical fields
      if (open === null || high === null || low === null || close === null || adjClose === null || volume === null) {
        continue;
      }

      const date = new Date(result.timestamp[i] * 1000);
      const tradeDate = formatDate(date);

      prices.push({
        companyId: 0, // Will be populated by caller
        tradeDate,
        open,
        high,
        low,
        close,
        adjClose,
        volume,
      });
    }

    return prices;
  } catch (error) {
    logger.error({ symbol, error }, 'Failed to fetch Yahoo Finance data');
    return [];
  }
}

async function getLastPriceDate(db: Pool, companyId: number): Promise<Date | null> {
  try {
    const result = await db.query(
      'SELECT MAX(trade_date) as max_date FROM price_history WHERE company_id = $1',
      [companyId]
    );

    const maxDate = result.rows[0]?.max_date;
    return maxDate ? new Date(maxDate) : null;
  } catch (error) {
    logger.error({ companyId, error }, 'Failed to query last price date');
    return null;
  }
}

async function insertPrices(db: Pool, prices: PriceRecord[]): Promise<{ inserted: number; updated: number; errors: string[] }> {
  const inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  if (prices.length === 0) {
    return { inserted, updated, errors };
  }

  try {
    const query = `
      INSERT INTO price_history (
        company_id, trade_date, open_price, high_price, low_price,
        close_price, adj_close, volume
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (company_id, trade_date)
      DO UPDATE SET
        open_price = EXCLUDED.open_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price,
        adj_close = EXCLUDED.adj_close,
        volume = EXCLUDED.volume
      WHERE price_history.adj_close IS DISTINCT FROM EXCLUDED.adj_close
        OR price_history.volume IS DISTINCT FROM EXCLUDED.volume
    `;

    for (const price of prices) {
      try {
        const result = await db.query(query, [
          price.companyId,
          price.tradeDate,
          price.open,
          price.high,
          price.low,
          price.close,
          price.adjClose,
          price.volume,
        ]);

        if (result.rowCount === 1) {
          updated++;
        }
      } catch (error) {
        errors.push(`Failed to insert price for company ${price.companyId} on ${price.tradeDate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { inserted: prices.length - errors.length, updated, errors };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`Batch insert failed: ${msg}`);
    return { inserted: 0, updated, errors };
  }
}

export async function run(db: Pool, options?: { companyIds?: number[]; days?: number }): Promise<IngestResult> {
  const startTime = Date.now();
  let recordsProcessed = 0;
  let recordsInserted = 0;
  let recordsUpdated = 0;
  const errors: string[] = [];

  try {
    // Fetch companies to process
    let query = 'SELECT id, ticker, nse_symbol FROM companies WHERE is_active = true ORDER BY id';
    const params: unknown[] = [];

    if (options?.companyIds && options.companyIds.length > 0) {
      query = 'SELECT id, ticker, nse_symbol FROM companies WHERE id = ANY($1) AND is_active = true ORDER BY id';
      params.push(options.companyIds);
    }

    const companiesResult = await db.query(query, params);
    const companies: PriceCompany[] = companiesResult.rows;

    if (companies.length === 0) {
      logger.info('No active companies found for price ingestion');
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors,
        durationMs: Date.now() - startTime,
      };
    }

    logger.info({ count: companies.length }, 'Processing price data for companies');

    // Process in batches of 10
    const batches = chunk(companies, 10);

    for (const batch of batches) {
      for (const company of batch) {
        try {
          // Append .NS suffix for Yahoo Finance (NSE listings)
          const baseTicker = (company.nse_symbol || company.ticker).trim().toUpperCase();
          const symbol = baseTicker.endsWith('.NS') || baseTicker.endsWith('.BO')
            ? baseTicker
            : `${baseTicker}.NS`;

          // Determine date range to fetch
          const lastDate = await getLastPriceDate(db, company.id);
          let startDate: Date;
          let endDate = new Date();

          if (lastDate) {
            // Incremental: last trading day only
            startDate = new Date(lastDate);
            startDate.setDate(startDate.getDate() - 1); // Fetch from day before last known date
          } else {
            // Historical backfill: 10 years
            startDate = daysAgo(options?.days || 3650); // ~10 years
          }

          const startEpoch = Math.floor(startDate.getTime() / 1000);
          const endEpoch = Math.floor(endDate.getTime() / 1000);

          logger.debug(
            { symbol, companyId: company.id, startDate: formatDate(startDate), endDate: formatDate(endDate) },
            'Fetching prices from Yahoo Finance'
          );

          // Fetch from primary source (Yahoo Finance)
          const prices = await fetchYahooData(symbol, startEpoch, endEpoch);

          if (prices.length === 0) {
            logger.warn({ symbol, companyId: company.id }, 'No price data retrieved');
            continue;
          }

          // Attach company ID
          const enrichedPrices = prices.map((p) => ({
            ...p,
            companyId: company.id,
          }));

          // Insert/update prices
          const result = await insertPrices(db, enrichedPrices);
          recordsProcessed += prices.length;
          recordsInserted += result.inserted;
          recordsUpdated += result.updated;

          if (result.errors.length > 0) {
            errors.push(...result.errors);
          }

          logger.info(
            { symbol, companyId: company.id, count: prices.length, inserted: result.inserted, updated: result.updated },
            'Price data ingested'
          );

          // Rate limiting: ~3 requests/second
          await rateLimitedWait('yahoo', 3);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const errMsg = `Failed to process prices for company ${company.id}: ${msg}`;
          errors.push(errMsg);
          logger.error({ companyId: company.id, error }, errMsg);
        }
      }

      // Small delay between batches
      if (batches.indexOf(batch) < batches.length - 1) {
        await sleep(500);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const errMsg = `Price ingestion pipeline failed: ${msg}`;
    errors.push(errMsg);
    logger.error({ error }, errMsg);
  }

  const durationMs = Date.now() - startTime;
  logger.info(
    { recordsProcessed, recordsInserted, recordsUpdated, errorCount: errors.length, durationMs },
    'Price ingestion completed'
  );

  return {
    recordsProcessed,
    recordsInserted,
    recordsUpdated,
    errors,
    durationMs,
  };
}
