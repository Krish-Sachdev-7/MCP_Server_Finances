/**
 * Insider Trading Disclosures Ingestion Pipeline
 *
 * Primary Source: NSE insider trading disclosures (SAST data)
 * Fallback: BSE insider trading data
 * Schedule: Daily on weekdays (0 17 * * 1-5 = 5 PM Monday-Friday)
 * Fields: insiderName, relationship, transactionType (buy/sell), shares, value, tradeDate, disclosureDate
 *
 * Captures insider buy/sell transactions disclosed on stock exchanges.
 */

import type { Pool } from '../db/connection.js';
import { rootLogger } from '../middleware/logger.js';
import {
  fetchJson,
  rateLimitedWait,
  safeNum,
  chunk,
  formatDate,
} from './utils.js';
import type { IngestResult } from './runner.js';

const logger = rootLogger.child({ module: 'ingestion:insider-trades' });

// Rate limiting configuration
const NSE_RATE_LIMIT_PER_SEC = 5;
const BSE_RATE_LIMIT_PER_SEC = 3;

// ============================================================
// TYPE DEFINITIONS
// ============================================================

interface InsiderTrade {
  companyId: number;
  ticker: string;
  insiderName: string;
  relationship: string;
  transactionType: 'buy' | 'sell';
  shares: number | null;
  valueCr: number | null;
  tradeDate: string | null;
  disclosureDate: string | null;
}

interface RawInsiderTrade {
  ticker: string;
  insiderName?: string;
  relationship?: string;
  transactionType: 'buy' | 'sell';
  shares?: number | null;
  value?: number | null;
  tradeDate?: string;
  disclosureDate?: string;
}

// ============================================================
// FETCH COMPANIES TICKER MAPPING
// ============================================================

async function fetchCompanyIdMapping(db: Pool): Promise<Map<string, number>> {
  try {
    const result = await db.query('SELECT id, ticker FROM companies WHERE is_active = TRUE');
    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(row.ticker.toUpperCase(), row.id);
    }
    return map;
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to fetch company mapping');
    return new Map();
  }
}

// ============================================================
// FETCH FROM PRIMARY SOURCE (NSE SAST)
// ============================================================

async function fetchFromNSEPrimary(): Promise<RawInsiderTrade[]> {
  const trades: RawInsiderTrade[] = [];

  try {
    logger.info('Fetching insider trades from NSE primary source');

    await rateLimitedWait('nseindia.com', NSE_RATE_LIMIT_PER_SEC);

    // NSE SAST (Shareholding of Specified Securities in Company) API
    const url = 'https://www.nseindia.com/api/insider-trades';

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Empty response from NSE insider trades API');
      return trades;
    }

    // Handle different response formats
    const records = Array.isArray(response) ? response :
                   (response.data && Array.isArray(response.data)) ? response.data :
                   (response.trades && Array.isArray(response.trades)) ? response.trades :
                   [];

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;

      try {
        const r = record as Record<string, unknown>;

        const ticker = String(r.symbol ?? r.Symbol ?? r.scripcode ?? r.ScripCode ?? '').trim().toUpperCase();
        if (!ticker) continue;

        // Extract transaction type
        const transStr = String(r.transaction ?? r.Transaction ?? r.type ?? r.Type ?? '').toLowerCase();
        const transactionType: 'buy' | 'sell' = transStr.includes('sell') ? 'sell' : 'buy';

        // Extract insider details
        const insiderName = String(r.insidername ?? r.InsiderName ?? r.name ?? r.Name ?? '').trim();
        if (!insiderName) continue;

        const relationship = String(r.relationship ?? r.Relationship ?? r.designation ?? r.Designation ?? '').trim();

        // Extract shares
        const shares = safeNum(String(r.shares ?? r.Shares ?? r.quantity ?? r.Quantity ?? ''));

        // Extract value (in crores)
        const valueCr = safeNum(String(r.valuecrore ?? r.ValueCrore ?? r.value ?? r.Value ?? ''));

        // Extract dates
        let tradeDate: string | undefined;
        let disclosureDate: string | undefined;

        const tDate = r.tradedate ?? r.TradeDate ?? r.contractdate ?? r.ContractDate ?? r.tradeddate ?? r.TradedDate;
        const dDate = r.disclosuredate ?? r.DisclosureDate ?? r.reporteddate ?? r.ReportedDate ?? r.dateofdisclosure ?? r.DateOfDisclosure;

        if (tDate) tradeDate = formatDate(new Date(tDate as string | Date)) ?? undefined;
        if (dDate) disclosureDate = formatDate(new Date(dDate as string | Date)) ?? undefined;

        trades.push({
          ticker,
          insiderName,
          relationship: relationship || 'Unknown',
          transactionType,
          shares,
          value: valueCr,
          tradeDate,
          disclosureDate,
        });
      } catch (err) {
        logger.debug({ record, error: String(err) }, 'Error parsing NSE insider trade');
      }
    }

    logger.info({ tradeCount: trades.length }, 'NSE primary fetch completed');
    return trades;
  } catch (error) {
    logger.warn({ error: String(error) }, 'NSE primary fetch failed, will try BSE fallback');
    return [];
  }
}

// ============================================================
// FETCH FROM FALLBACK SOURCE (BSE)
// ============================================================

async function fetchFromBSEFallback(): Promise<RawInsiderTrade[]> {
  const trades: RawInsiderTrade[] = [];

  try {
    logger.info('Fetching insider trades from BSE fallback source');

    await rateLimitedWait('bseindia.com', BSE_RATE_LIMIT_PER_SEC);

    // BSE insider trading disclosure page/API
    const url = 'https://api.bseindia.com/BseIndiaAPI/api/InsiderTrading/w';

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Empty response from BSE insider trades API');
      return trades;
    }

    // Handle different response formats
    const records = Array.isArray(response) ? response :
                   (response.data && Array.isArray(response.data)) ? response.data :
                   (response.records && Array.isArray(response.records)) ? response.records :
                   [];

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;

      try {
        const r = record as Record<string, unknown>;

        const ticker = String(r.scripcode ?? r.ScripCode ?? r.symbol ?? r.Symbol ?? '').trim().toUpperCase();
        if (!ticker) continue;

        // Extract transaction type
        const transStr = String(r.buysell ?? r.BuySell ?? r.buyorsell ?? r.BuyOrSell ?? '').toLowerCase();
        const transactionType: 'buy' | 'sell' = transStr.includes('sell') ? 'sell' : 'buy';

        // Extract insider details
        const insiderName = String(r.insidername ?? r.InsiderName ?? r.name ?? r.Name ?? '').trim();
        if (!insiderName) continue;

        const relationship = String(r.relationship ?? r.Relationship ?? r.position ?? r.Position ?? '').trim();

        // Extract shares and value
        const shares = safeNum(String(r.shares ?? r.Shares ?? r.quantity ?? r.Quantity ?? ''));
        const valueCr = safeNum(String(r.valuecrore ?? r.ValueCrore ?? r.value ?? r.Value ?? ''));

        // Extract dates
        let tradeDate: string | undefined;
        let disclosureDate: string | undefined;

        const tDate = r.tradedate ?? r.TradeDate ?? r.dateoftransaction ?? r.DateOfTransaction;
        const dDate = r.disclosuredate ?? r.DisclosureDate ?? r.dateofdisclosure ?? r.DateOfDisclosure;

        if (tDate) tradeDate = formatDate(new Date(tDate as string | Date)) ?? undefined;
        if (dDate) disclosureDate = formatDate(new Date(dDate as string | Date)) ?? undefined;

        trades.push({
          ticker,
          insiderName,
          relationship: relationship || 'Unknown',
          transactionType,
          shares,
          value: valueCr,
          tradeDate,
          disclosureDate,
        });
      } catch (err) {
        logger.debug({ record, error: String(err) }, 'Error parsing BSE insider trade');
      }
    }

    logger.info({ tradeCount: trades.length }, 'BSE fallback fetch completed');
    return trades;
  } catch (error) {
    logger.error({ error: String(error) }, 'BSE fallback fetch failed');
    return [];
  }
}

// ============================================================
// UPSERT INSIDER TRADES
// ============================================================

async function upsertInsiderTrades(
  db: Pool,
  trades: InsiderTrade[]
): Promise<{ inserted: number; updated: number; errors: string[] }> {
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  const batchSize = 100;
  const batches = chunk(trades, batchSize);

  for (const batch of batches) {
    try {
      const valuesToInsert = batch
        .map((_, idx) => {
          const offset = idx * 8;
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
        })
        .join(',');

      const params: (number | string | null)[] = [];
      for (const t of batch) {
        params.push(
          t.companyId,
          t.insiderName,
          t.relationship,
          t.transactionType,
          t.shares,
          t.valueCr,
          t.tradeDate,
          t.disclosureDate
        );
      }

      const query = `
        INSERT INTO insider_trades (
          company_id, insider_name, relationship, transaction_type,
          shares, value_cr, trade_date, disclosure_date
        )
        VALUES ${valuesToInsert}
        ON CONFLICT (company_id, insider_name, transaction_type, trade_date, disclosure_date)
        DO UPDATE SET
          shares = EXCLUDED.shares,
          value_cr = COALESCE(EXCLUDED.value_cr, insider_trades.value_cr)
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
      const msg = `Insider trades batch upsert error: ${String(error)}`;
      logger.error({ error: String(error), batchSize: batch.length }, msg);
      errors.push(msg);
    }
  }

  return { inserted, updated, errors };
}

// ============================================================
// MAIN PIPELINE
// ============================================================

async function run(db: Pool): Promise<IngestResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let recordsProcessed = 0;
  let recordsInserted = 0;
  let recordsUpdated = 0;

  try {
    logger.info('Starting insider trades ingestion pipeline');

    // Fetch company mapping
    const companyMap = await fetchCompanyIdMapping(db);
    if (companyMap.size === 0) {
      logger.error('No companies found in database');
      errors.push('No companies found');
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors,
        durationMs: Date.now() - startTime,
      };
    }

    // Try primary source (NSE SAST)
    let trades = await fetchFromNSEPrimary();

    // If primary failed, try fallback (BSE)
    if (trades.length === 0) {
      logger.info('Primary source returned no data, trying BSE fallback');
      trades = await fetchFromBSEFallback();
    }

    if (trades.length === 0) {
      logger.info('No insider trades retrieved from NSE or BSE');
      // This is not necessarily an error — no trades may have been disclosed today
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors,
        durationMs: Date.now() - startTime,
      };
    }

    // Map to company IDs and filter out unknown tickers
    const mappedTrades: InsiderTrade[] = [];
    for (const trade of trades) {
      const companyId = companyMap.get(trade.ticker);
      if (!companyId) {
        logger.debug({ ticker: trade.ticker }, 'Unknown ticker, skipping');
        continue;
      }

      mappedTrades.push({
        companyId,
        ticker: trade.ticker,
        insiderName: trade.insiderName || 'Unknown',
        relationship: trade.relationship || 'Unknown',
        transactionType: trade.transactionType,
        shares: trade.shares || null,
        valueCr: trade.value || null,
        tradeDate: trade.tradeDate || null,
        disclosureDate: trade.disclosureDate || null,
      });
    }

    recordsProcessed = mappedTrades.length;

    if (mappedTrades.length === 0) {
      logger.warn('No valid insider trades after company mapping');
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors,
        durationMs: Date.now() - startTime,
      };
    }

    logger.info({ tradeCount: mappedTrades.length }, 'Upserting insider trades');

    // Upsert to database
    const result = await upsertInsiderTrades(db, mappedTrades);
    recordsInserted = result.inserted;
    recordsUpdated = result.updated;
    errors.push(...result.errors);

    const durationMs = Date.now() - startTime;
    logger.info(
      {
        recordsProcessed,
        recordsInserted,
        recordsUpdated,
        errorCount: errors.length,
        durationMs,
      },
      'Insider trades ingestion pipeline completed'
    );

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated,
      errors,
      durationMs,
    };
  } catch (error) {
    const msg = `Insider trades pipeline failed: ${String(error)}`;
    logger.error({ error: String(error) }, msg);
    errors.push(msg);

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated,
      errors,
      durationMs: Date.now() - startTime,
    };
  }
}

// Export pipeline interface
export const name = 'insider_trades';
export const schedule = '0 17 * * 1-5'; // Weekdays at 5 PM
export { run };
