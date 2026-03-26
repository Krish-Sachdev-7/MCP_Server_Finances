-- EquityMCP Initial Schema
-- Designed for ~7000 Indian listed companies with 15 years of financial history
-- All monetary values stored in crores (INR) unless noted otherwise
-- All percentage values stored as decimals (0.15 = 15%)

-- ============================================================
-- CORE TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  ticker VARCHAR(20) NOT NULL,
  company_name VARCHAR(255) NOT NULL,
  isin VARCHAR(12) UNIQUE,
  bse_code VARCHAR(10),
  nse_symbol VARCHAR(20),
  sector VARCHAR(100),
  industry VARCHAR(150),
  market_cap_cr NUMERIC(14, 2),
  face_value NUMERIC(6, 2) DEFAULT 10,
  listing_date DATE,
  exchange VARCHAR(10) DEFAULT 'NSE',
  website VARCHAR(255),
  registrar VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable trigram extension for fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_ticker ON companies(ticker);
CREATE INDEX IF NOT EXISTS idx_companies_sector ON companies(sector);
CREATE INDEX IF NOT EXISTS idx_companies_industry ON companies(industry);
CREATE INDEX IF NOT EXISTS idx_companies_market_cap ON companies(market_cap_cr);
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON companies USING gin(company_name gin_trgm_ops);

-- ============================================================
-- FINANCIAL STATEMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS financials_annual (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  fiscal_year INTEGER NOT NULL,
  period_end_date DATE,
  -- Income statement
  revenue NUMERIC(14, 2),
  expenses NUMERIC(14, 2),
  operating_profit NUMERIC(14, 2),
  other_income NUMERIC(14, 2),
  depreciation NUMERIC(14, 2),
  interest_expense NUMERIC(14, 2),
  profit_before_tax NUMERIC(14, 2),
  tax_expense NUMERIC(14, 2),
  net_profit NUMERIC(14, 2),
  eps NUMERIC(10, 2),
  -- Balance sheet
  equity_capital NUMERIC(14, 2),
  reserves NUMERIC(14, 2),
  total_borrowings NUMERIC(14, 2),
  other_liabilities NUMERIC(14, 2),
  fixed_assets NUMERIC(14, 2),
  cwip NUMERIC(14, 2),
  investments NUMERIC(14, 2),
  other_assets NUMERIC(14, 2),
  total_assets NUMERIC(14, 2),
  -- Cash flow
  operating_cash_flow NUMERIC(14, 2),
  investing_cash_flow NUMERIC(14, 2),
  financing_cash_flow NUMERIC(14, 2),
  net_cash_flow NUMERIC(14, 2),
  capex NUMERIC(14, 2),
  -- Metadata
  is_consolidated BOOLEAN DEFAULT TRUE,
  data_source VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, fiscal_year, is_consolidated)
);

CREATE INDEX IF NOT EXISTS idx_fin_annual_company ON financials_annual(company_id);
CREATE INDEX IF NOT EXISTS idx_fin_annual_year ON financials_annual(fiscal_year);

CREATE TABLE IF NOT EXISTS financials_quarterly (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  fiscal_year INTEGER NOT NULL,
  quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  period_end_date DATE,
  revenue NUMERIC(14, 2),
  expenses NUMERIC(14, 2),
  operating_profit NUMERIC(14, 2),
  other_income NUMERIC(14, 2),
  depreciation NUMERIC(14, 2),
  interest_expense NUMERIC(14, 2),
  profit_before_tax NUMERIC(14, 2),
  tax_expense NUMERIC(14, 2),
  net_profit NUMERIC(14, 2),
  eps NUMERIC(10, 2),
  is_consolidated BOOLEAN DEFAULT TRUE,
  data_source VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, fiscal_year, quarter, is_consolidated)
);

CREATE INDEX IF NOT EXISTS idx_fin_quarterly_company ON financials_quarterly(company_id);

-- ============================================================
-- COMPUTED RATIOS (materialized for fast screening)
-- ============================================================

CREATE TABLE IF NOT EXISTS ratios (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  fiscal_year INTEGER NOT NULL,
  -- Valuation
  pe_ratio NUMERIC(10, 2),
  pb_ratio NUMERIC(10, 2),
  ev_ebitda NUMERIC(10, 2),
  price_to_sales NUMERIC(10, 2),
  earnings_yield NUMERIC(8, 4),
  dividend_yield NUMERIC(8, 4),
  -- Profitability
  roe NUMERIC(8, 4),
  roce NUMERIC(8, 4),
  operating_margin NUMERIC(8, 4),
  net_margin NUMERIC(8, 4),
  -- Leverage
  debt_to_equity NUMERIC(10, 2),
  current_ratio NUMERIC(10, 2),
  interest_coverage NUMERIC(10, 2),
  -- Efficiency
  asset_turnover NUMERIC(10, 2),
  inventory_turnover NUMERIC(10, 2),
  -- Growth (YoY)
  revenue_growth_yoy NUMERIC(8, 4),
  profit_growth_yoy NUMERIC(8, 4),
  eps_growth_yoy NUMERIC(8, 4),
  -- Growth (multi-year CAGR)
  revenue_cagr_3y NUMERIC(8, 4),
  revenue_cagr_5y NUMERIC(8, 4),
  revenue_cagr_10y NUMERIC(8, 4),
  profit_cagr_3y NUMERIC(8, 4),
  profit_cagr_5y NUMERIC(8, 4),
  profit_cagr_10y NUMERIC(8, 4),
  -- Quality scores
  piotroski_score INTEGER CHECK (piotroski_score BETWEEN 0 AND 9),
  -- Free cash flow
  fcf NUMERIC(14, 2),
  fcf_yield NUMERIC(8, 4),
  -- Book value
  book_value_per_share NUMERIC(10, 2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, fiscal_year)
);

CREATE INDEX IF NOT EXISTS idx_ratios_company ON ratios(company_id);
CREATE INDEX IF NOT EXISTS idx_ratios_year ON ratios(fiscal_year);
CREATE INDEX IF NOT EXISTS idx_ratios_pe ON ratios(pe_ratio);
CREATE INDEX IF NOT EXISTS idx_ratios_roe ON ratios(roe);
CREATE INDEX IF NOT EXISTS idx_ratios_roce ON ratios(roce);
CREATE INDEX IF NOT EXISTS idx_ratios_debt ON ratios(debt_to_equity);
CREATE INDEX IF NOT EXISTS idx_ratios_piotroski ON ratios(piotroski_score);

-- ============================================================
-- PRICE HISTORY
-- ============================================================

CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  trade_date DATE NOT NULL,
  open_price NUMERIC(10, 2),
  high_price NUMERIC(10, 2),
  low_price NUMERIC(10, 2),
  close_price NUMERIC(10, 2),
  adj_close NUMERIC(10, 2),
  volume BIGINT,
  delivery_percentage NUMERIC(6, 2),
  UNIQUE(company_id, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_price_company_date ON price_history(company_id, trade_date DESC);

-- ============================================================
-- SHAREHOLDING PATTERNS
-- ============================================================

CREATE TABLE IF NOT EXISTS shareholding_patterns (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  quarter_end_date DATE NOT NULL,
  promoter_holding NUMERIC(8, 4),
  fii_holding NUMERIC(8, 4),
  dii_holding NUMERIC(8, 4),
  public_holding NUMERIC(8, 4),
  government_holding NUMERIC(8, 4),
  pledged_percentage NUMERIC(8, 4),
  total_shares BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, quarter_end_date)
);

CREATE INDEX IF NOT EXISTS idx_shareholding_company ON shareholding_patterns(company_id);

-- ============================================================
-- CORPORATE ACTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS corporate_actions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  action_type VARCHAR(30) NOT NULL, -- 'dividend', 'split', 'bonus', 'rights', 'buyback'
  ex_date DATE,
  record_date DATE,
  details VARCHAR(500),
  value NUMERIC(10, 4), -- dividend amount, split ratio, bonus ratio
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_corp_actions_company ON corporate_actions(company_id);
CREATE INDEX IF NOT EXISTS idx_corp_actions_date ON corporate_actions(ex_date DESC);

-- ============================================================
-- INSIDER TRADES
-- ============================================================

CREATE TABLE IF NOT EXISTS insider_trades (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  insider_name VARCHAR(255),
  relationship VARCHAR(100), -- 'Promoter', 'Promoter Group', 'Key Managerial'
  transaction_type VARCHAR(10) NOT NULL, -- 'buy', 'sell'
  shares BIGINT,
  value_cr NUMERIC(14, 4),
  trade_date DATE,
  disclosure_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insider_company ON insider_trades(company_id);
CREATE INDEX IF NOT EXISTS idx_insider_date ON insider_trades(trade_date DESC);

-- ============================================================
-- INDEX CONSTITUENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS index_constituents (
  id SERIAL PRIMARY KEY,
  index_name VARCHAR(50) NOT NULL, -- 'NIFTY 50', 'NIFTY BANK', etc.
  company_id INTEGER NOT NULL REFERENCES companies(id),
  weight NUMERIC(8, 4),
  effective_date DATE,
  is_current BOOLEAN DEFAULT TRUE,
  UNIQUE(index_name, company_id, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_index_name ON index_constituents(index_name);

-- ============================================================
-- MACRO INDICATORS
-- ============================================================

CREATE TABLE IF NOT EXISTS macro_indicators (
  id SERIAL PRIMARY KEY,
  indicator_date DATE NOT NULL,
  repo_rate NUMERIC(6, 4),
  reverse_repo_rate NUMERIC(6, 4),
  cpi_inflation NUMERIC(6, 2),
  wpi_inflation NUMERIC(6, 2),
  gdp_growth NUMERIC(6, 2),
  iip_growth NUMERIC(6, 2),
  pmi_manufacturing NUMERIC(6, 2),
  pmi_services NUMERIC(6, 2),
  usd_inr_rate NUMERIC(8, 4),
  crude_oil_usd NUMERIC(8, 2),
  gold_inr_per_10g NUMERIC(10, 2),
  fii_net_buy_cr NUMERIC(14, 2),
  dii_net_buy_cr NUMERIC(14, 2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(indicator_date)
);

-- ============================================================
-- ANNOUNCEMENTS AND EVENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  event_type VARCHAR(50) NOT NULL, -- 'board_meeting', 'agm', 'results', 'bonus', etc.
  event_date DATE,
  title VARCHAR(500),
  details TEXT,
  source_url VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_announcements_company ON announcements(company_id);
CREATE INDEX IF NOT EXISTS idx_announcements_date ON announcements(event_date DESC);

-- ============================================================
-- USER DATA (watchlists, custom screens)
-- ============================================================

CREATE TABLE IF NOT EXISTS watchlists (
  id SERIAL PRIMARY KEY,
  client_id VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  tickers TEXT[] NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, name)
);

CREATE TABLE IF NOT EXISTS custom_screens (
  id SERIAL PRIMARY KEY,
  client_id VARCHAR(100),
  name VARCHAR(100) NOT NULL,
  conditions TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PIPELINE STATUS (tracks ingestion runs)
-- ============================================================

CREATE TABLE IF NOT EXISTS pipeline_status (
  id SERIAL PRIMARY KEY,
  pipeline_name VARCHAR(50) NOT NULL,
  last_run_at TIMESTAMPTZ,
  records_processed INTEGER DEFAULT 0,
  records_inserted INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'idle', -- 'running', 'success', 'failed', 'idle'
  error_message TEXT,
  duration_ms INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_name ON pipeline_status(pipeline_name);

-- ============================================================
-- EXTENSIBILITY: Plugin metadata registry
-- ============================================================

CREATE TABLE IF NOT EXISTS plugin_registry (
  id SERIAL PRIMARY KEY,
  plugin_name VARCHAR(100) NOT NULL UNIQUE,
  version VARCHAR(20) NOT NULL,
  description TEXT,
  tool_count INTEGER DEFAULT 0,
  table_names TEXT[],
  enabled BOOLEAN DEFAULT TRUE,
  installed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the pipeline status table
INSERT INTO pipeline_status (pipeline_name, status)
VALUES
  ('companies', 'idle'),
  ('financials', 'idle'),
  ('prices', 'idle'),
  ('shareholding', 'idle'),
  ('corporate_actions', 'idle'),
  ('insider_trades', 'idle'),
  ('macro_indicators', 'idle'),
  ('announcements', 'idle')
ON CONFLICT (pipeline_name) DO NOTHING;
