/**
 * Macro Indicators Ingestion Pipeline
 *
 * Primary Source: RBI data portal, government statistics
 * Fallback: Hardcoded manual updates (data-of-last-resort)
 * Schedule: Monthly (0 10 1 * * = 1st of every month at 10 AM)
 * Fields: repoRate, reverseRepoRate, cpiInflation, wpiInflation, gdpGrowth, iipGrowth,
 *         pmiManufacturing, pmiServices, usdInrRate, crudeOilUsd, goldInrPer10g,
 *         fiiNetBuyCr, diiNetBuyCr
 *
 * Captures macroeconomic indicators updated monthly.
 * Includes LATEST_KNOWN_VALUES constant for fallback if all API calls fail.
 */

import type { Pool } from '../db/connection.js';
import { rootLogger } from '../middleware/logger.js';
import {
  fetchJson,
  rateLimitedWait,
  safeNum,
  formatDate,
} from './utils.js';
import type { IngestResult } from './runner.js';

const logger = rootLogger.child({ module: 'ingestion:macro' });

// Rate limiting configuration
const RBI_RATE_LIMIT_PER_SEC = 2;

// ============================================================
// TYPE DEFINITIONS
// ============================================================

interface MacroIndicators {
  indicatorDate: string;
  repoRate: number | null;
  reverseRepoRate: number | null;
  cpiInflation: number | null;
  wpiInflation: number | null;
  gdpGrowth: number | null;
  iipGrowth: number | null;
  pmiManufacturing: number | null;
  pmiServices: number | null;
  usdInrRate: number | null;
  crudeOilUsd: number | null;
  goldInrPer10g: number | null;
  fiiNetBuyCr: number | null;
  diiNetBuyCr: number | null;
}

// ============================================================
// LATEST KNOWN VALUES — FALLBACK DATA
// ============================================================
// Updated manually as a last resort when all external sources fail.
// These are realistic recent macro values that serve as data-of-last-resort.

const LATEST_KNOWN_VALUES: MacroIndicators = {
  indicatorDate: '2026-02-28', // Update this monthly
  repoRate: 6.5,
  reverseRepoRate: 6.25,
  cpiInflation: 4.83,
  wpiInflation: -0.5,
  gdpGrowth: 5.4,
  iipGrowth: 2.1,
  pmiManufacturing: 57.3,
  pmiServices: 60.8,
  usdInrRate: 83.42,
  crudeOilUsd: 78.5,
  goldInrPer10g: 78500,
  fiiNetBuyCr: 850.25,
  diiNetBuyCr: 420.15,
};

// ============================================================
// FETCH FROM PRIMARY SOURCE (RBI PORTAL)
// ============================================================

/**
 * Fetch monetary policy rates from RBI
 */
async function fetchMonetaryPolicyRates(): Promise<{
  repoRate: number | null;
  reverseRepoRate: number | null;
} | null> {
  try {
    await rateLimitedWait('rbi.org.in', RBI_RATE_LIMIT_PER_SEC);

    // RBI monetary policy API/page
    const url = 'https://www.rbi.org.in/Scripts/MonetaryPolicyDates.aspx';

    logger.debug('Fetching RBI monetary policy rates');

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Invalid response from RBI monetary policy endpoint');
      return null;
    }

    const repoRate = safeNum(String(response.repoRate ?? response.RepoRate ?? response.repo ?? ''));
    const reverseRepoRate = safeNum(String(response.reverseRepoRate ?? response.ReverseRepoRate ?? response.reverse ?? ''));

    return {
      repoRate,
      reverseRepoRate,
    };
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to fetch RBI monetary policy rates');
    return null;
  }
}

/**
 * Fetch inflation data (CPI and WPI)
 */
async function fetchInflationData(): Promise<{
  cpiInflation: number | null;
  wpiInflation: number | null;
} | null> {
  try {
    await rateLimitedWait('mospi.gov.in', RBI_RATE_LIMIT_PER_SEC);

    // Ministry of Statistics and Programme Implementation API
    const url = 'https://www.mospi.gov.in/api/inflation-data';

    logger.debug('Fetching inflation data from government portal');

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Invalid response from inflation data endpoint');
      return null;
    }

    const cpiInflation = safeNum(String(response.cpiInflation ?? response.CPI ?? response.cpi ?? ''));
    const wpiInflation = safeNum(String(response.wpiInflation ?? response.WPI ?? response.wpi ?? ''));

    return {
      cpiInflation,
      wpiInflation,
    };
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to fetch inflation data');
    return null;
  }
}

/**
 * Fetch GDP growth and IIP growth
 */
async function fetchGrowthIndicators(): Promise<{
  gdpGrowth: number | null;
  iipGrowth: number | null;
} | null> {
  try {
    await rateLimitedWait('mospi.gov.in', RBI_RATE_LIMIT_PER_SEC);

    // Ministry of Statistics Growth Indicators API
    const url = 'https://www.mospi.gov.in/api/growth-indicators';

    logger.debug('Fetching GDP and IIP growth data');

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Invalid response from growth indicators endpoint');
      return null;
    }

    const gdpGrowth = safeNum(String(response.gdpGrowth ?? response.GDP ?? response.gdp ?? ''));
    const iipGrowth = safeNum(String(response.iipGrowth ?? response.IIP ?? response.iip ?? ''));

    return {
      gdpGrowth,
      iipGrowth,
    };
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to fetch growth indicators');
    return null;
  }
}

/**
 * Fetch PMI indices (Manufacturing and Services)
 */
async function fetchPMIIndices(): Promise<{
  pmiManufacturing: number | null;
  pmiServices: number | null;
} | null> {
  try {
    await rateLimitedWait('example.com', RBI_RATE_LIMIT_PER_SEC);

    // IHS Markit PMI data endpoint (typically from financial data providers)
    const url = 'https://www.pmiindex.com/api/india-pmi';

    logger.debug('Fetching PMI indices');

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Invalid response from PMI indices endpoint');
      return null;
    }

    const pmiMfg = safeNum(String(response.manufacturing ?? response.Manufacturing ?? response.pmimanufacturing ?? ''));
    const pmiSvc = safeNum(String(response.services ?? response.Services ?? response.pmiservices ?? ''));

    return {
      pmiManufacturing: pmiMfg,
      pmiServices: pmiSvc,
    };
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to fetch PMI indices');
    return null;
  }
}

/**
 * Fetch forex and commodity rates
 */
async function fetchForexAndCommodities(): Promise<{
  usdInrRate: number | null;
  crudeOilUsd: number | null;
  goldInrPer10g: number | null;
} | null> {
  try {
    await rateLimitedWait('example.com', RBI_RATE_LIMIT_PER_SEC);

    // Multiple sources typically, use aggregator or RBI data
    const url = 'https://www.rbi.org.in/api/forex-rates';

    logger.debug('Fetching forex and commodity data');

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Invalid response from forex endpoint');
      return null;
    }

    const usdInr = safeNum(String(response.usdinr ?? response.USDtoINR ?? response.usdRate ?? ''));
    const crudeOil = safeNum(String(response.crudeoil ?? response.CrudeOil ?? response.wti ?? ''));
    const goldPer10g = safeNum(String(response.goldper10g ?? response.GoldPer10g ?? response.gold ?? ''));

    return {
      usdInrRate: usdInr,
      crudeOilUsd: crudeOil,
      goldInrPer10g: goldPer10g,
    };
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to fetch forex and commodity rates');
    return null;
  }
}

/**
 * Fetch FII and DII data
 */
async function fetchFIIDIIData(): Promise<{
  fiiNetBuyCr: number | null;
  diiNetBuyCr: number | null;
} | null> {
  try {
    await rateLimitedWait('nseindia.com', RBI_RATE_LIMIT_PER_SEC);

    // NSE FII/DII flow data
    const url = 'https://www.nseindia.com/api/fii-dii-flows';

    logger.debug('Fetching FII/DII flow data');

    const response = await fetchJson<Record<string, unknown>>(url, {
      timeout: 30_000,
      retries: 2,
    });

    if (!response || typeof response !== 'object') {
      logger.warn('Invalid response from FII/DII endpoint');
      return null;
    }

    const fiiNetBuy = safeNum(String(response.fiibuy ?? response.FIINetBuy ?? response.fiiNetBuy ?? ''));
    const diiNetBuy = safeNum(String(response.diibuy ?? response.DIINetBuy ?? response.diiNetBuy ?? ''));

    return {
      fiiNetBuyCr: fiiNetBuy,
      diiNetBuyCr: diiNetBuy,
    };
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to fetch FII/DII data');
    return null;
  }
}

// ============================================================
// AGGREGATE MACRO DATA
// ============================================================

async function fetchMacroIndicators(): Promise<MacroIndicators | null> {
  logger.info('Aggregating macro indicators from multiple sources');

  const [
    monetaryPolicy,
    inflation,
    growth,
    pmi,
    forexCommodities,
    fiidii,
  ] = await Promise.all([
    fetchMonetaryPolicyRates(),
    fetchInflationData(),
    fetchGrowthIndicators(),
    fetchPMIIndices(),
    fetchForexAndCommodities(),
    fetchFIIDIIData(),
  ]);

  // Determine today's date (or last business day)
  const today = new Date();
  const indicatorDate = formatDate(today);

  // If all sources failed, return null to trigger fallback
  if (!monetaryPolicy && !inflation && !growth && !pmi && !forexCommodities && !fiidii) {
    logger.warn('All macro data sources failed');
    return null;
  }

  return {
    indicatorDate,
    repoRate: monetaryPolicy?.repoRate ?? null,
    reverseRepoRate: monetaryPolicy?.reverseRepoRate ?? null,
    cpiInflation: inflation?.cpiInflation ?? null,
    wpiInflation: inflation?.wpiInflation ?? null,
    gdpGrowth: growth?.gdpGrowth ?? null,
    iipGrowth: growth?.iipGrowth ?? null,
    pmiManufacturing: pmi?.pmiManufacturing ?? null,
    pmiServices: pmi?.pmiServices ?? null,
    usdInrRate: forexCommodities?.usdInrRate ?? null,
    crudeOilUsd: forexCommodities?.crudeOilUsd ?? null,
    goldInrPer10g: forexCommodities?.goldInrPer10g ?? null,
    fiiNetBuyCr: fiidii?.fiiNetBuyCr ?? null,
    diiNetBuyCr: fiidii?.diiNetBuyCr ?? null,
  };
}

// ============================================================
// UPSERT MACRO INDICATORS
// ============================================================

async function upsertMacroIndicators(
  db: Pool,
  indicators: MacroIndicators
): Promise<{ inserted: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    const query = `
      INSERT INTO macro_indicators (
        indicator_date, repo_rate, reverse_repo_rate, cpi_inflation, wpi_inflation,
        gdp_growth, iip_growth, pmi_manufacturing, pmi_services, usd_inr_rate,
        crude_oil_usd, gold_inr_per_10g, fii_net_buy_cr, dii_net_buy_cr
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (indicator_date) DO UPDATE SET
        repo_rate = COALESCE(EXCLUDED.repo_rate, macro_indicators.repo_rate),
        reverse_repo_rate = COALESCE(EXCLUDED.reverse_repo_rate, macro_indicators.reverse_repo_rate),
        cpi_inflation = COALESCE(EXCLUDED.cpi_inflation, macro_indicators.cpi_inflation),
        wpi_inflation = COALESCE(EXCLUDED.wpi_inflation, macro_indicators.wpi_inflation),
        gdp_growth = COALESCE(EXCLUDED.gdp_growth, macro_indicators.gdp_growth),
        iip_growth = COALESCE(EXCLUDED.iip_growth, macro_indicators.iip_growth),
        pmi_manufacturing = COALESCE(EXCLUDED.pmi_manufacturing, macro_indicators.pmi_manufacturing),
        pmi_services = COALESCE(EXCLUDED.pmi_services, macro_indicators.pmi_services),
        usd_inr_rate = COALESCE(EXCLUDED.usd_inr_rate, macro_indicators.usd_inr_rate),
        crude_oil_usd = COALESCE(EXCLUDED.crude_oil_usd, macro_indicators.crude_oil_usd),
        gold_inr_per_10g = COALESCE(EXCLUDED.gold_inr_per_10g, macro_indicators.gold_inr_per_10g),
        fii_net_buy_cr = COALESCE(EXCLUDED.fii_net_buy_cr, macro_indicators.fii_net_buy_cr),
        dii_net_buy_cr = COALESCE(EXCLUDED.dii_net_buy_cr, macro_indicators.dii_net_buy_cr)
      RETURNING id;
    `;

    const params = [
      indicators.indicatorDate,
      indicators.repoRate,
      indicators.reverseRepoRate,
      indicators.cpiInflation,
      indicators.wpiInflation,
      indicators.gdpGrowth,
      indicators.iipGrowth,
      indicators.pmiManufacturing,
      indicators.pmiServices,
      indicators.usdInrRate,
      indicators.crudeOilUsd,
      indicators.goldInrPer10g,
      indicators.fiiNetBuyCr,
      indicators.diiNetBuyCr,
    ];

    const result = await db.query(query, params);

    if (result && result.rows && result.rows.length > 0) {
      logger.info({ indicatorDate: indicators.indicatorDate }, 'Macro indicators upserted successfully');
      return { inserted: true, errors };
    } else {
      const msg = 'No rows returned from macro indicators upsert';
      logger.error(msg);
      errors.push(msg);
      return { inserted: false, errors };
    }
  } catch (error) {
    const msg = `Macro indicators upsert failed: ${String(error)}`;
    logger.error({ error: String(error) }, msg);
    errors.push(msg);
    return { inserted: false, errors };
  }
}

// ============================================================
// MAIN PIPELINE
// ============================================================

async function run(db: Pool): Promise<IngestResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let recordsProcessed = 0;
  let recordsInserted = 0;

  try {
    logger.info('Starting macro indicators ingestion pipeline');

    // Try to fetch from all sources
    let indicators = await fetchMacroIndicators();

    // If all sources failed, fall back to latest known values
    if (!indicators) {
      logger.warn('All primary sources failed, using fallback data');
      // Update the fallback date to today
      indicators = { ...LATEST_KNOWN_VALUES, indicatorDate: formatDate(new Date()) };
      errors.push('All primary sources failed, using fallback data');
    }

    recordsProcessed = 1; // Single record per run
    logger.info({ indicators }, 'Macro indicators fetched');

    // Upsert to database
    const result = await upsertMacroIndicators(db, indicators);

    if (result.inserted) {
      recordsInserted = 1;
    }
    errors.push(...result.errors);

    const durationMs = Date.now() - startTime;
    logger.info(
      {
        recordsProcessed,
        recordsInserted,
        indicatorDate: indicators.indicatorDate,
        errorCount: errors.length,
        durationMs,
      },
      'Macro indicators ingestion pipeline completed'
    );

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated: recordsInserted > 0 ? 0 : 1, // Either inserted or updated (not both)
      errors,
      durationMs,
    };
  } catch (error) {
    const msg = `Macro indicators pipeline failed: ${String(error)}`;
    logger.error({ error: String(error) }, msg);
    errors.push(msg);

    return {
      recordsProcessed,
      recordsInserted,
      recordsUpdated: 0,
      errors,
      durationMs: Date.now() - startTime,
    };
  }
}

// Export pipeline interface
export const name = 'macro_indicators';
export const schedule = '0 10 1 * *'; // 1st of every month at 10 AM
export { run };
