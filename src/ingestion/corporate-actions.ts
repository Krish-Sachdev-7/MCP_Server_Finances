/**
 * Corporate Actions Ingestion Pipeline
 *
 * Primary Source: BSE corporate actions page or NSE corporate announcements
 * Fallback: NSE if BSE fails, or vice versa
 * Schedule: Weekly (0 9 * * 0 = Sundays at 9 AM)
 * Fields: actionType (dividend/split/bonus/rights/buyback), exDate, recordDate, details, value
 *
 * Uses ON CONFLICT to avoid duplicates (match on company_id + action_type + ex_date)
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

const logger = rootLogger.child({ module: 'ingestion:corporate-actions' });

// Rate limiting configuration
const BSE_RATE_LIMIT_PER_SEC = 3;
const NSE_RATE_LIMIT_PER_SEC = 5;

// ============================================================
// TYPE DEFINITIONS
// ============================================================

interface CorporateAction {
  companyId: number;
  ticker: string;
  actionType: string; // 'dividend', 'split', 'bonus', 'rights', 'buyback'
  exDate: string | null;
  recordDate: string | null;
  details: string | null;
  value: number | null;
}

interface RawCorporateAction {
  ticker: string;
  actionType: string;
  exDate?: string;
  recordDate?: string;
  details?: string;
  value?: number | null;
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
// FETCH FROM PRIMARY SOURCE (BSE)
// ============================================================

async function fetchFromBSEPrimary(): Promise<RawCorporateAction[]> {
  const actions: RawCorporateAction[] = [];

  try {
    logger.info('Fetching corporate actions from BSE primary source');

    await rateLimitedWait('bseindia.com', BSE_RATE_LIMIT_PER_SEC);

    // BSE corporate actions API endpoint
    const url = 'https://api.bseindia.com/BseIndiaAPI/api/CorporateAction/w';

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Empty response from BSE corporate actions API');
      return actions;
    }

    // Handle different response formats (array or object with data property)
    const records = Array.isArray(response) ? response :
                   (response.data && Array.isArray(response.data)) ? response.data :
                   [];

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;

      try {
        const r = record as Record<string, unknown>;

        // Extract action type
        const actionTypeStr = String(r.actiontype ?? r.ActionType ?? r.purpose ?? r.Purpose ?? '').toLowerCase();
        let actionType = 'dividend';
        if (actionTypeStr.includes('split')) actionType = 'split';
        else if (actionTypeStr.includes('bonus')) actionType = 'bonus';
        else if (actionTypeStr.includes('rights')) actionType = 'rights';
        else if (actionTypeStr.includes('buyback')) actionType = 'buyback';

        const ticker = String(r.scripcode ?? r.ScripCode ?? r.symbol ?? r.Symbol ?? '').trim().toUpperCase();
        if (!ticker) continue;

        // Extract dates
        let exDate: string | undefined;
        let recordDate: string | undefined;
        const exD = r.exdate ?? r.ExDate ?? r.exoffdate ?? r.ExOffDate;
        const recD = r.recorddate ?? r.RecordDate ?? r.paymentdate ?? r.PaymentDate;

        if (exD) exDate = formatDate(new Date(exD as string | Date)) ?? undefined;
        if (recD) recordDate = formatDate(new Date(recD as string | Date)) ?? undefined;

        const details = String(r.details ?? r.Details ?? r.description ?? r.Description ?? '').slice(0, 500);
        const value = safeNum(String(r.value ?? r.Value ?? r.amount ?? r.Amount ?? '')) ?? undefined;

        actions.push({
          ticker,
          actionType,
          exDate,
          recordDate,
          details: details || undefined,
          value,
        });
      } catch (err) {
        logger.debug({ record, error: String(err) }, 'Error parsing BSE corporate action');
      }
    }

    logger.info({ actionCount: actions.length }, 'BSE primary fetch completed');
    return actions;
  } catch (error) {
    logger.warn({ error: String(error) }, 'BSE primary fetch failed, will try NSE fallback');
    return [];
  }
}

// ============================================================
// FETCH FROM FALLBACK SOURCE (NSE)
// ============================================================

async function fetchFromNSEFallback(): Promise<RawCorporateAction[]> {
  const actions: RawCorporateAction[] = [];

  try {
    logger.info('Fetching corporate actions from NSE fallback source');

    await rateLimitedWait('nseindia.com', NSE_RATE_LIMIT_PER_SEC);

    // NSE corporate announcements endpoint
    const url = 'https://www.nseindia.com/api/corporate-announcements';

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Empty response from NSE corporate announcements API');
      return actions;
    }

    // Handle different response formats
    const records = Array.isArray(response) ? response :
                   (response.data && Array.isArray(response.data)) ? response.data :
                   (response.announcements && Array.isArray(response.announcements)) ? response.announcements :
                   [];

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;

      try {
        const r = record as Record<string, unknown>;

        // Extract action type
        const purposeStr = String(r.purpose ?? r.Purpose ?? r.type ?? r.Type ?? '').toLowerCase();
        let actionType = 'dividend';
        if (purposeStr.includes('split')) actionType = 'split';
        else if (purposeStr.includes('bonus')) actionType = 'bonus';
        else if (purposeStr.includes('rights')) actionType = 'rights';
        else if (purposeStr.includes('buyback')) actionType = 'buyback';

        const ticker = String(r.symbol ?? r.Symbol ?? r.scripcode ?? r.ScripCode ?? '').trim().toUpperCase();
        if (!ticker) continue;

        // Extract dates
        let exDate: string | undefined;
        let recordDate: string | undefined;
        const exD = r.exdate ?? r.ExDate ?? r.ndstarted ?? r.NDStarted;
        const recD = r.recorddate ?? r.RecordDate ?? r.ndended ?? r.NDEnded;

        if (exD) exDate = formatDate(new Date(exD as string | Date)) ?? undefined;
        if (recD) recordDate = formatDate(new Date(recD as string | Date)) ?? undefined;

        const details = String(r.details ?? r.Details ?? r.remarks ?? r.Remarks ?? '').slice(0, 500);
        const value = safeNum(String(r.value ?? r.Value ?? r.facevalue ?? r.FaceValue ?? ''));

        actions.push({
          ticker,
          actionType,
          exDate,
          recordDate,
          details: details || undefined,
          value,
        });
      } catch (err) {
        logger.debug({ record, error: String(err) }, 'Error parsing NSE corporate action');
      }
    }

    logger.info({ actionCount: actions.length }, 'NSE fallback fetch completed');
    return actions;
  } catch (error) {
    logger.error({ error: String(error) }, 'NSE fallback fetch failed');
    return [];
  }
}

// ============================================================
// UPSERT CORPORATE ACTIONS
// ============================================================

async function upsertCorporateActions(
  db: Pool,
  actions: CorporateAction[]
): Promise<{ inserted: number; updated: number; errors: string[] }> {
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  const batchSize = 100;
  const batches = chunk(actions, batchSize);

  for (const batch of batches) {
    try {
      const valuesToInsert = batch
        .map((_, idx) => {
          const offset = idx * 7;
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
        })
        .join(',');

      const params: (number | string | null)[] = [];
      for (const a of batch) {
        params.push(
          a.companyId,
          a.actionType,
          a.exDate,
          a.recordDate,
          a.details,
          a.value,
          a.value !== null ? new Date().toISOString() : null
        );
      }

      const query = `
        INSERT INTO corporate_actions (
          company_id, action_type, ex_date, record_date, details, value, created_at
        )
        VALUES ${valuesToInsert}
        ON CONFLICT (company_id, action_type, ex_date) DO UPDATE SET
          record_date = EXCLUDED.record_date,
          details = COALESCE(EXCLUDED.details, corporate_actions.details),
          value = COALESCE(EXCLUDED.value, corporate_actions.value)
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
      const msg = `Corporate actions batch upsert error: ${String(error)}`;
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
    logger.info('Starting corporate actions ingestion pipeline');

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

    // Try primary source (BSE)
    let actions = await fetchFromBSEPrimary();

    // If primary failed, try fallback (NSE)
    if (actions.length === 0) {
      logger.info('Primary source returned no data, trying NSE fallback');
      actions = await fetchFromNSEFallback();
    }

    if (actions.length === 0) {
      logger.warn('Both BSE and NSE returned no corporate actions');
      errors.push('No corporate actions retrieved from BSE or NSE');
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors,
        durationMs: Date.now() - startTime,
      };
    }

    // Map to company IDs and filter out unknown tickers
    const mappedActions: CorporateAction[] = [];
    for (const action of actions) {
      const companyId = companyMap.get(action.ticker);
      if (!companyId) {
        logger.debug({ ticker: action.ticker }, 'Unknown ticker, skipping');
        continue;
      }

      mappedActions.push({
        companyId,
        ticker: action.ticker,
        actionType: action.actionType,
        exDate: action.exDate || null,
        recordDate: action.recordDate || null,
        details: action.details || null,
        value: action.value || null,
      });
    }

    recordsProcessed = mappedActions.length;

    if (mappedActions.length === 0) {
      logger.warn('No valid corporate actions after company mapping');
      errors.push('No valid corporate actions after company mapping');
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors,
        durationMs: Date.now() - startTime,
      };
    }

    logger.info({ actionCount: mappedActions.length }, 'Upserting corporate actions');

    // Upsert to database
    const result = await upsertCorporateActions(db, mappedActions);
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
      'Corporate actions ingestion pipeline completed'
    );

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated,
      errors,
      durationMs,
    };
  } catch (error) {
    const msg = `Corporate actions pipeline failed: ${String(error)}`;
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
export const name = 'corporate_actions';
export const schedule = '0 9 * * 0'; // Sundays at 9 AM
export { run };
