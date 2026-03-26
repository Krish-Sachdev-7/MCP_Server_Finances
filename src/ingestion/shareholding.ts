/**
 * Shareholding Pattern Ingestion Pipeline
 *
 * Source: BSE shareholding pattern filings
 * Schedule: Quarterly (0 8 1 every-3-months)
 * Fields: promoterHolding, fiiHolding, diiHolding, publicHolding, pledgedPercentage, totalShares
 *
 * Tracks quarter-over-quarter changes in shareholding patterns.
 * No fallback source — if BSE fails, logs and retries next cycle.
 */

import type { Pool } from '../db/connection.js';
import { rootLogger } from '../middleware/logger.js';
import {
  fetchJson,
  rateLimitedWait,
  sleep,
  safeNum,
  chunk,
  formatDate,
} from './utils.js';
import type { IngestResult } from './runner.js';

const logger = rootLogger.child({ module: 'ingestion:shareholding' });

// BSE API rate limiting
const BSE_RATE_LIMIT_PER_SEC = 3;

// ============================================================
// TYPE DEFINITIONS
// ============================================================

interface ShareholdingData {
  companyId: number;
  ticker: string;
  quarterEndDate: string;
  promoterHolding: number | null;
  fiiHolding: number | null;
  diiHolding: number | null;
  publicHolding: number | null;
  governmentHolding: number | null;
  pledgedPercentage: number | null;
  totalShares: number | null;
}

interface CompanyBseCode {
  id: number;
  ticker: string;
  bseCode: string;
}

// ============================================================
// FETCH SHAREHOLDING DATA FROM BSE
// ============================================================

/**
 * Get list of companies with their BSE codes
 */
async function fetchCompaniesBseMapping(db: Pool): Promise<CompanyBseCode[]> {
  try {
    const result = await db.query(
      'SELECT id, ticker, bse_code FROM companies WHERE bse_code IS NOT NULL AND is_active = TRUE'
    );
    return result.rows as CompanyBseCode[];
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to fetch companies BSE mapping');
    return [];
  }
}

/**
 * Fetch shareholding pattern from BSE for a specific company
 */
async function fetchShareholdingFromBSE(bseCode: string): Promise<ShareholdingData | null> {
  try {
    await rateLimitedWait('bseindia.com', BSE_RATE_LIMIT_PER_SEC);

    const url = `https://api.bseindia.com/BseIndiaAPI/api/CorporateAction/w?scripcode=${bseCode}&segment=Equity&purpose=Shareholding+Pattern`;

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.debug({ bseCode }, 'Empty response from BSE for shareholding');
      return null;
    }

    // Extract shareholding data from BSE response
    // BSE API structure varies, handle multiple response formats
    const data = Array.isArray(response) ? response[0] : response;

    if (!data || typeof data !== 'object') {
      logger.debug({ bseCode }, 'Invalid shareholding data structure');
      return null;
    }

    const record = data as Record<string, unknown>;

    // Extract holding percentages (BSE typically returns as decimals 0-100)
    const promoter = safeNum(String(record.promoterholding ?? record.PromoterHolding ?? ''));
    const fii = safeNum(String(record.fiiholding ?? record.FIIHolding ?? ''));
    const dii = safeNum(String(record.diiholding ?? record.DIIHolding ?? ''));
    const publicHold = safeNum(String(record.publicholding ?? record.PublicHolding ?? ''));
    const government = safeNum(String(record.governmentholding ?? record.GovernmentHolding ?? ''));
    const pledged = safeNum(String(record.pledgedpercentage ?? record.PledgedPercentage ?? ''));

    // Convert from percentages to decimals if needed (handle 50 vs 0.50 format)
    const normalize = (val: number | null): number | null => {
      if (val === null) return null;
      return val > 1 ? val / 100 : val;
    };

    // Quarter end date extraction
    let quarterEndDate = record.asof ?? record.AsOf ?? record.quarterenddate ?? record.QuarterEndDate;
    if (!quarterEndDate) {
      // If no date, use last day of current quarter
      const now = new Date();
      const quarter = Math.floor((now.getMonth() + 3) / 3);
      const year = now.getFullYear();
      const lastMonth = quarter * 3;
      quarterEndDate = new Date(year, lastMonth, 0);
    }

    const quarterEndStr = formatDate(new Date(quarterEndDate as string | Date));

    // Total shares
    const totalShares = safeNum(String(record.totalshares ?? record.TotalShares ?? ''));

    return {
      companyId: 0, // Will be set by caller
      ticker: '',   // Will be set by caller
      quarterEndDate: quarterEndStr,
      promoterHolding: normalize(promoter),
      fiiHolding: normalize(fii),
      diiHolding: normalize(dii),
      publicHolding: normalize(publicHold),
      governmentHolding: normalize(government),
      pledgedPercentage: normalize(pledged),
      totalShares: totalShares ? Math.floor(totalShares) : null,
    };
  } catch (error) {
    logger.debug(
      { bseCode, error: String(error) },
      'Error fetching shareholding from BSE'
    );
    return null;
  }
}

/**
 * Fetch shareholding patterns for all companies
 */
async function fetchShareholdingPatterns(
  _db: Pool,
  companies: CompanyBseCode[]
): Promise<ShareholdingData[]> {
  const results: ShareholdingData[] = [];
  const errors: string[] = [];

  for (const company of companies) {
    try {
      const data = await fetchShareholdingFromBSE(company.bseCode);

      if (data) {
        data.companyId = company.id;
        data.ticker = company.ticker;
        results.push(data);
      }
    } catch (error) {
      const msg = `Failed to fetch shareholding for ${company.ticker}: ${String(error)}`;
      logger.warn({ ticker: company.ticker, error: String(error) }, msg);
      errors.push(msg);
    }

    // Small delay between companies
    await sleep(100);
  }

  if (errors.length > 0) {
    logger.warn(
      { errorCount: errors.length, sampleErrors: errors.slice(0, 3) },
      'Some shareholding fetches failed'
    );
  }

  return results;
}

// ============================================================
// UPSERT SHAREHOLDING PATTERNS
// ============================================================

/**
 * Upsert shareholding patterns into the database
 */
async function upsertShareholdingPatterns(
  db: Pool,
  patterns: ShareholdingData[]
): Promise<{ inserted: number; updated: number; errors: string[] }> {
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  const batchSize = 50;
  const batches = chunk(patterns, batchSize);

  for (const batch of batches) {
    try {
      const valuesToInsert = batch
        .map((_, idx) => {
          const offset = idx * 9;
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
        })
        .join(',');

      const params: (number | string | null)[] = [];
      for (const p of batch) {
        params.push(
          p.companyId,
          p.quarterEndDate,
          p.promoterHolding,
          p.fiiHolding,
          p.diiHolding,
          p.publicHolding,
          p.governmentHolding,
          p.pledgedPercentage,
          p.totalShares
        );
      }

      const query = `
        INSERT INTO shareholding_patterns (
          company_id, quarter_end_date, promoter_holding, fii_holding,
          dii_holding, public_holding, government_holding, pledged_percentage, total_shares
        )
        VALUES ${valuesToInsert}
        ON CONFLICT (company_id, quarter_end_date) DO UPDATE SET
          promoter_holding = EXCLUDED.promoter_holding,
          fii_holding = EXCLUDED.fii_holding,
          dii_holding = EXCLUDED.dii_holding,
          public_holding = EXCLUDED.public_holding,
          government_holding = EXCLUDED.government_holding,
          pledged_percentage = EXCLUDED.pledged_percentage,
          total_shares = EXCLUDED.total_shares
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
      const msg = `Shareholding batch upsert error: ${String(error)}`;
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
    logger.info('Starting shareholding ingestion pipeline');

    // Fetch companies with BSE codes
    const companies = await fetchCompaniesBseMapping(db);

    if (companies.length === 0) {
      logger.warn('No companies with BSE codes found');
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors: ['No companies with BSE codes found'],
        durationMs: Date.now() - startTime,
      };
    }

    logger.info({ companyCount: companies.length }, 'Fetching shareholding patterns');

    // Fetch shareholding patterns
    const patterns = await fetchShareholdingPatterns(db, companies);
    recordsProcessed = patterns.length;

    if (patterns.length === 0) {
      logger.warn('No shareholding patterns retrieved from BSE');
      errors.push('No shareholding patterns retrieved from BSE');
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors,
        durationMs: Date.now() - startTime,
      };
    }

    logger.info({ patternCount: patterns.length }, 'Upserting shareholding patterns');

    // Upsert to database
    const result = await upsertShareholdingPatterns(db, patterns);
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
      'Shareholding ingestion pipeline completed'
    );

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated,
      errors,
      durationMs,
    };
  } catch (error) {
    const msg = `Shareholding pipeline failed: ${String(error)}`;
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
export const name = 'shareholding';
export const schedule = '0 8 1 */3 *'; // First day of every quarter at 8 AM
export { run };
