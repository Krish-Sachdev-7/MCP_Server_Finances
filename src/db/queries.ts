import type { Pool } from './connection.js';

// ============================================================
// COMPANY QUERIES
// ============================================================

export async function searchCompanies(
  db: Pool,
  query: string,
  options: { limit?: number; sector?: string; marketCapMin?: number; marketCapMax?: number } = {}
) {
  const { limit = 10, sector, marketCapMin, marketCapMax } = options;
  const params: unknown[] = [`%${query}%`, `%${query}%`, query.toUpperCase(), limit];
  let whereExtra = '';
  let paramIdx = 5;

  if (sector) {
    whereExtra += ` AND c.sector = $${paramIdx}`;
    params.push(sector);
    paramIdx++;
  }
  if (marketCapMin !== undefined) {
    whereExtra += ` AND c.market_cap_cr >= $${paramIdx}`;
    params.push(marketCapMin);
    paramIdx++;
  }
  if (marketCapMax !== undefined) {
    whereExtra += ` AND c.market_cap_cr <= $${paramIdx}`;
    params.push(marketCapMax);
    paramIdx++;
  }

  const sql = `
    SELECT c.id, c.ticker, c.company_name, c.isin, c.sector, c.industry,
           c.market_cap_cr, c.exchange, c.is_active
    FROM companies c
    WHERE c.is_active = TRUE
      AND (c.company_name ILIKE $1 OR c.ticker ILIKE $2 OR c.isin = $3)
      ${whereExtra}
    ORDER BY
      CASE WHEN c.ticker = $3 THEN 0
           WHEN c.ticker ILIKE $2 THEN 1
           ELSE 2
      END,
      similarity(c.company_name, $1) DESC
    LIMIT $4
  `;

  const { rows } = await db.query(sql, params);
  return rows;
}

export async function getCompanyByTicker(db: Pool, ticker: string) {
  const { rows } = await db.query(
    `SELECT * FROM companies WHERE ticker = $1 AND is_active = TRUE`,
    [ticker.toUpperCase()]
  );
  return rows[0] || null;
}

export async function getCompanyById(db: Pool, id: number) {
  const { rows } = await db.query(
    `SELECT * FROM companies WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function getCompanyPeers(db: Pool, companyId: number, limit = 10) {
  const { rows } = await db.query(
    `SELECT c2.* FROM companies c1
     JOIN companies c2 ON c1.industry = c2.industry AND c2.id != c1.id AND c2.is_active = TRUE
     WHERE c1.id = $1
     ORDER BY ABS(c2.market_cap_cr - c1.market_cap_cr)
     LIMIT $2`,
    [companyId, limit]
  );
  return rows;
}

export async function getCompanyCount(db: Pool): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*) as count FROM companies WHERE is_active = TRUE`
  );
  return parseInt(rows[0].count, 10);
}

// ============================================================
// FINANCIAL QUERIES
// ============================================================

export async function getAnnualFinancials(
  db: Pool,
  companyId: number,
  years = 5
) {
  const { rows } = await db.query(
    `SELECT * FROM financials_annual
     WHERE company_id = $1 AND is_consolidated = TRUE
     ORDER BY fiscal_year DESC
     LIMIT $2`,
    [companyId, years]
  );
  return rows;
}

export async function getQuarterlyFinancials(
  db: Pool,
  companyId: number,
  quarters = 8
) {
  const { rows } = await db.query(
    `SELECT * FROM financials_quarterly
     WHERE company_id = $1 AND is_consolidated = TRUE
     ORDER BY fiscal_year DESC, quarter DESC
     LIMIT $2`,
    [companyId, quarters]
  );
  return rows;
}

export async function getRatios(
  db: Pool,
  companyId: number,
  years = 10
) {
  const { rows } = await db.query(
    `SELECT * FROM ratios
     WHERE company_id = $1
     ORDER BY fiscal_year DESC
     LIMIT $2`,
    [companyId, years]
  );
  return rows;
}

// ============================================================
// PRICE QUERIES
// ============================================================

export async function getPriceHistory(
  db: Pool,
  companyId: number,
  days = 365
) {
  const { rows } = await db.query(
    `SELECT * FROM price_history
     WHERE company_id = $1
       AND trade_date >= CURRENT_DATE - $2::INTEGER
     ORDER BY trade_date ASC`,
    [companyId, days]
  );
  return rows;
}

export async function getLatestPrice(db: Pool, companyId: number) {
  const { rows } = await db.query(
    `SELECT * FROM price_history
     WHERE company_id = $1
     ORDER BY trade_date DESC
     LIMIT 1`,
    [companyId]
  );
  return rows[0] || null;
}

// ============================================================
// SHAREHOLDING QUERIES
// ============================================================

export async function getShareholdingPattern(
  db: Pool,
  companyId: number,
  quarters = 8
) {
  const { rows } = await db.query(
    `SELECT * FROM shareholding_patterns
     WHERE company_id = $1
     ORDER BY quarter_end_date DESC
     LIMIT $2`,
    [companyId, quarters]
  );
  return rows;
}

/**
 * Get shareholding for multiple companies (for comparison / screening).
 * Returns the latest quarter for each company.
 */
export async function getLatestShareholding(
  db: Pool,
  companyIds: number[]
) {
  if (companyIds.length === 0) return [];
  const placeholders = companyIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.query(
    `SELECT DISTINCT ON (sp.company_id)
       sp.*, c.ticker, c.company_name
     FROM shareholding_patterns sp
     JOIN companies c ON sp.company_id = c.id
     WHERE sp.company_id IN (${placeholders})
     ORDER BY sp.company_id, sp.quarter_end_date DESC`,
    companyIds
  );
  return rows;
}

/**
 * Get bulk and block deals.
 * These are recorded as insider_trades with special relationship markers,
 * or we query insider_trades with large value thresholds.
 */
export async function getBulkBlockDeals(
  db: Pool,
  options: { companyId?: number; days?: number; minValueCr?: number } = {}
) {
  const { companyId, days = 30, minValueCr = 1 } = options;
  const params: unknown[] = [days, minValueCr];
  const conditions: string[] = [
    'it.trade_date >= CURRENT_DATE - $1::INTEGER',
    'it.value_cr >= $2',
  ];
  let paramIdx = 3;

  if (companyId) {
    conditions.push(`it.company_id = $${paramIdx}`);
    params.push(companyId);
    paramIdx++;
  }

  const { rows } = await db.query(
    `SELECT it.*, c.ticker, c.company_name
     FROM insider_trades it
     JOIN companies c ON it.company_id = c.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY it.value_cr DESC, it.trade_date DESC
     LIMIT 100`,
    params
  );
  return rows;
}

/**
 * Get upcoming corporate actions (ex_date in the future).
 */
export async function getUpcomingCorporateActions(
  db: Pool,
  options: { days?: number; actionType?: string } = {}
) {
  const { days = 90, actionType } = options;
  const params: unknown[] = [days];
  let typeFilter = '';

  if (actionType) {
    typeFilter = ' AND ca.action_type = $2';
    params.push(actionType);
  }

  const { rows } = await db.query(
    `SELECT ca.*, c.ticker, c.company_name, c.sector
     FROM corporate_actions ca
     JOIN companies c ON ca.company_id = c.id
     WHERE ca.ex_date >= CURRENT_DATE
       AND ca.ex_date <= CURRENT_DATE + $1::INTEGER
       ${typeFilter}
     ORDER BY ca.ex_date ASC`,
    params
  );
  return rows;
}

// ============================================================
// CORPORATE ACTION QUERIES
// ============================================================

export async function getCorporateActions(
  db: Pool,
  companyId: number,
  actionType?: string
) {
  const params: unknown[] = [companyId];
  let typeFilter = '';

  if (actionType) {
    typeFilter = ' AND action_type = $2';
    params.push(actionType);
  }

  const { rows } = await db.query(
    `SELECT * FROM corporate_actions
     WHERE company_id = $1 ${typeFilter}
     ORDER BY ex_date DESC`,
    params
  );
  return rows;
}

// ============================================================
// INDEX QUERIES
// ============================================================

export async function getIndexConstituents(db: Pool, indexName: string) {
  const { rows } = await db.query(
    `SELECT ic.*, c.ticker, c.company_name, c.sector, c.market_cap_cr
     FROM index_constituents ic
     JOIN companies c ON ic.company_id = c.id
     WHERE ic.index_name = $1 AND ic.is_current = TRUE
     ORDER BY ic.weight DESC NULLS LAST`,
    [indexName]
  );
  return rows;
}

// ============================================================
// MACRO QUERIES
// ============================================================

export async function getMacroIndicators(db: Pool, months = 24) {
  const { rows } = await db.query(
    `SELECT * FROM macro_indicators
     WHERE indicator_date >= CURRENT_DATE - ($1::INTEGER * 30)
     ORDER BY indicator_date DESC`,
    [months]
  );
  return rows;
}

// ============================================================
// INSIDER TRADE QUERIES
// ============================================================

export async function getInsiderTrades(
  db: Pool,
  options: { companyId?: number; days?: number; transactionType?: string } = {}
) {
  const { companyId, days = 30, transactionType } = options;
  const params: unknown[] = [days];
  const conditions: string[] = ['it.trade_date >= CURRENT_DATE - $1::INTEGER'];
  let paramIdx = 2;

  if (companyId) {
    conditions.push(`it.company_id = $${paramIdx}`);
    params.push(companyId);
    paramIdx++;
  }
  if (transactionType && transactionType !== 'all') {
    conditions.push(`it.transaction_type = $${paramIdx}`);
    params.push(transactionType);
    paramIdx++;
  }

  const { rows } = await db.query(
    `SELECT it.*, c.ticker, c.company_name
     FROM insider_trades it
     JOIN companies c ON it.company_id = c.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY it.trade_date DESC
     LIMIT 100`,
    params
  );
  return rows;
}

// ============================================================
// SCREENING QUERIES (dynamic WHERE clause from parsed conditions)
// ============================================================

export async function runScreenQuery(
  db: Pool,
  whereClause: string,
  params: unknown[],
  sortBy = 'market_cap_cr',
  sortOrder = 'DESC',
  limit = 50
) {
  // sortBy and sortOrder are validated against allowlists before reaching here
  const { rows } = await db.query(
    `SELECT c.ticker, c.company_name, c.sector, c.industry, c.market_cap_cr,
            r.*
     FROM companies c
     JOIN ratios r ON c.id = r.company_id
     WHERE c.is_active = TRUE
       AND r.fiscal_year = (SELECT MAX(fiscal_year) FROM ratios WHERE company_id = c.id)
       ${whereClause ? 'AND ' + whereClause : ''}
     ORDER BY ${sortBy} ${sortOrder}
     LIMIT $${params.length + 1}`,
    [...params, limit]
  );
  return rows;
}

// ============================================================
// PIPELINE STATUS
// ============================================================

export async function updatePipelineStatus(
  db: Pool,
  pipelineName: string,
  status: string,
  result?: {
    recordsProcessed?: number;
    recordsInserted?: number;
    recordsUpdated?: number;
    durationMs?: number;
    errorMessage?: string;
  }
) {
  await db.query(
    `UPDATE pipeline_status SET
       status = $2,
       last_run_at = NOW(),
       records_processed = COALESCE($3, records_processed),
       records_inserted = COALESCE($4, records_inserted),
       records_updated = COALESCE($5, records_updated),
       duration_ms = COALESCE($6, duration_ms),
       error_message = $7,
       updated_at = NOW()
     WHERE pipeline_name = $1`,
    [
      pipelineName,
      status,
      result?.recordsProcessed ?? null,
      result?.recordsInserted ?? null,
      result?.recordsUpdated ?? null,
      result?.durationMs ?? null,
      result?.errorMessage ?? null,
    ]
  );
}
