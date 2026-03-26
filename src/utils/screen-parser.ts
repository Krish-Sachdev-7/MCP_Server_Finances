/**
 * Parses screener-style condition strings into parameterized SQL.
 *
 * Input: "ROCE > 20 AND Debt to equity < 0.5 AND Sales growth 5Years > 15"
 * Output: { whereClause: "r.roce > $1 AND r.debt_to_equity < $2 AND r.revenue_cagr_5y > $3",
 *           params: [0.20, 0.5, 0.15] }
 *
 * Extensible: add new aliases to FIELD_MAP to support new data fields.
 */

export interface ParsedScreen {
  whereClause: string;
  params: unknown[];
  errors: string[];
}

// Maps human-readable field names to SQL column references.
// Add new fields here when extending the schema.
const FIELD_MAP: Record<string, { column: string; isPercent: boolean }> = {
  // Valuation
  'pe': { column: 'r.pe_ratio', isPercent: false },
  'pe ratio': { column: 'r.pe_ratio', isPercent: false },
  'pb': { column: 'r.pb_ratio', isPercent: false },
  'pb ratio': { column: 'r.pb_ratio', isPercent: false },
  'ev/ebitda': { column: 'r.ev_ebitda', isPercent: false },
  'price to sales': { column: 'r.price_to_sales', isPercent: false },
  'earnings yield': { column: 'r.earnings_yield', isPercent: true },
  'dividend yield': { column: 'r.dividend_yield', isPercent: true },
  'fcf yield': { column: 'r.fcf_yield', isPercent: true },

  // Profitability
  'roe': { column: 'r.roe', isPercent: true },
  'return on equity': { column: 'r.roe', isPercent: true },
  'roce': { column: 'r.roce', isPercent: true },
  'return on capital': { column: 'r.roce', isPercent: true },
  'return on capital employed': { column: 'r.roce', isPercent: true },
  'operating margin': { column: 'r.operating_margin', isPercent: true },
  'net margin': { column: 'r.net_margin', isPercent: true },
  'net profit margin': { column: 'r.net_margin', isPercent: true },

  // Leverage
  'debt to equity': { column: 'r.debt_to_equity', isPercent: false },
  'debt/equity': { column: 'r.debt_to_equity', isPercent: false },
  'current ratio': { column: 'r.current_ratio', isPercent: false },
  'interest coverage': { column: 'r.interest_coverage', isPercent: false },

  // Growth
  'revenue growth': { column: 'r.revenue_growth_yoy', isPercent: true },
  'revenue growth yoy': { column: 'r.revenue_growth_yoy', isPercent: true },
  'profit growth': { column: 'r.profit_growth_yoy', isPercent: true },
  'profit growth yoy': { column: 'r.profit_growth_yoy', isPercent: true },
  'eps growth': { column: 'r.eps_growth_yoy', isPercent: true },
  'sales growth 3years': { column: 'r.revenue_cagr_3y', isPercent: true },
  'sales growth 5years': { column: 'r.revenue_cagr_5y', isPercent: true },
  'sales growth 10years': { column: 'r.revenue_cagr_10y', isPercent: true },
  'revenue cagr 3y': { column: 'r.revenue_cagr_3y', isPercent: true },
  'revenue cagr 5y': { column: 'r.revenue_cagr_5y', isPercent: true },
  'revenue cagr 10y': { column: 'r.revenue_cagr_10y', isPercent: true },
  'profit cagr 3y': { column: 'r.profit_cagr_3y', isPercent: true },
  'profit cagr 5y': { column: 'r.profit_cagr_5y', isPercent: true },
  'profit cagr 10y': { column: 'r.profit_cagr_10y', isPercent: true },

  // Quality
  'piotroski': { column: 'r.piotroski_score', isPercent: false },
  'piotroski score': { column: 'r.piotroski_score', isPercent: false },
  'f-score': { column: 'r.piotroski_score', isPercent: false },

  // Company-level
  'market cap': { column: 'c.market_cap_cr', isPercent: false },
  'market capitalization': { column: 'c.market_cap_cr', isPercent: false },
  'mcap': { column: 'c.market_cap_cr', isPercent: false },
};

// Sort by descending key length so "sales growth 10years" matches before "sales growth"
const SORTED_FIELDS = Object.entries(FIELD_MAP)
  .sort((a, b) => b[0].length - a[0].length);

const OPERATORS: Record<string, string> = {
  '>=': '>=',
  '<=': '<=',
  '>': '>',
  '<': '<',
  '=': '=',
  '!=': '!=',
};

export function parseScreenConditions(conditionString: string): ParsedScreen {
  const errors: string[] = [];
  const clauses: string[] = [];
  const params: unknown[] = [];

  // Split on AND (case-insensitive)
  const parts = conditionString.split(/\s+AND\s+/i);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const parsed = parseSingleCondition(trimmed, params.length + 1);
    if (parsed.error) {
      errors.push(parsed.error);
    } else if (parsed.clause && parsed.param !== undefined) {
      clauses.push(parsed.clause);
      params.push(parsed.param);
    }
  }

  return {
    whereClause: clauses.join(' AND '),
    params,
    errors,
  };
}

function parseSingleCondition(
  raw: string,
  paramIndex: number
): { clause?: string; param?: unknown; error?: string } {
  const normalized = raw.toLowerCase().trim();

  // Find matching field
  let matchedField: { column: string; isPercent: boolean } | null = null;
  let remainder = '';

  for (const [alias, field] of SORTED_FIELDS) {
    if (normalized.startsWith(alias)) {
      matchedField = field;
      remainder = normalized.slice(alias.length).trim();
      break;
    }
  }

  if (!matchedField) {
    return { error: `Unknown field in condition: "${raw}". Available fields: ${Object.keys(FIELD_MAP).slice(0, 10).join(', ')}...` };
  }

  // Find operator
  let operator: string | null = null;
  for (const [sym, sql] of Object.entries(OPERATORS)) {
    if (remainder.startsWith(sym)) {
      operator = sql;
      remainder = remainder.slice(sym.length).trim();
      break;
    }
  }

  if (!operator) {
    return { error: `Missing operator in condition: "${raw}". Use >, <, >=, <=, =` };
  }

  // Parse value
  const value = parseFloat(remainder);
  if (isNaN(value)) {
    return { error: `Invalid value in condition: "${raw}". Expected a number.` };
  }

  // If the field stores percentages as decimals but user provides whole numbers
  const adjustedValue = matchedField.isPercent && Math.abs(value) > 1
    ? value / 100
    : value;

  return {
    clause: `${matchedField.column} ${operator} $${paramIndex}`,
    param: adjustedValue,
  };
}

// Allowed sort columns (prevent SQL injection in ORDER BY)
const ALLOWED_SORT_COLUMNS: Record<string, string> = {
  'market_cap': 'c.market_cap_cr',
  'market_cap_cr': 'c.market_cap_cr',
  'pe': 'r.pe_ratio',
  'roe': 'r.roe',
  'roce': 'r.roce',
  'revenue_growth': 'r.revenue_growth_yoy',
  'profit_growth': 'r.profit_growth_yoy',
  'dividend_yield': 'r.dividend_yield',
  'debt_to_equity': 'r.debt_to_equity',
  'piotroski_score': 'r.piotroski_score',
};

export function validateSortColumn(col: string): string {
  const normalized = col.toLowerCase().trim();
  return ALLOWED_SORT_COLUMNS[normalized] || 'c.market_cap_cr';
}

export function validateSortOrder(order: string): string {
  const normalized = order.toUpperCase().trim();
  return normalized === 'ASC' ? 'ASC' : 'DESC';
}
