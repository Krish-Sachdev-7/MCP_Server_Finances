# MCP_Server_Finances
# EquityMCP: Complete Project Breakdown

## What this is

EquityMCP is a production-grade server that exposes financial data for Indian listed companies through the Model Context Protocol (MCP). Any AI agent that supports MCP can connect to it over the internet and immediately gain access to fundamental analysis, valuation modeling, stock screening, technical indicators, portfolio analytics, and structured research outputs for roughly 7000 companies listed on the BSE and NSE. The closest analogy is screener.in rebuilt from scratch as an API layer purpose-built for consumption by LLMs and AI agents rather than human browsers.

The server runs as a single deployable Node.js application backed by PostgreSQL for persistent storage and Redis for caching. It communicates with clients using Streamable HTTP (the current MCP standard), with SSE fallback for older clients and stdio for local development with Claude Desktop. Once deployed to a cloud provider and pointed at a URL, any MCP-compatible client can connect and start calling tools with zero additional integration work.

## Technical architecture

### Stack

TypeScript on Node.js 20+. The MCP SDK is Anthropic's official `@modelcontextprotocol/sdk` v2.x. Input validation on every tool uses Zod schemas. The database is PostgreSQL 16, chosen because the dataset is fundamentally relational (companies have financials have ratios have prices) and because Postgres supports trigram indexes for fuzzy company name search out of the box. Redis 7 handles caching with domain-specific TTLs ranging from 5 minutes for live price data to 24 hours for index constituents. The application is containerized via Docker with a multi-stage build that produces a slim production image.

### Database schema

14 tables across four categories.

**Core entity tables:** `companies` stores the master record for each listed company (ticker, name, ISIN, sector, industry, market cap, listing date, exchange). It has a trigram index on company_name for sub-100ms fuzzy search across the full universe.

**Financial data tables:** `financials_annual` holds 15 years of P&L, balance sheet, and cash flow line items per company per fiscal year. `financials_quarterly` holds the same at quarterly granularity. `ratios` is a materialized table of 25+ precomputed financial ratios (PE, PB, ROE, ROCE, debt-to-equity, margins, growth rates, Piotroski score, FCF yield) indexed on the columns most commonly used in screening queries. `price_history` stores daily OHLCV data with a composite index on company_id and trade_date for fast range lookups.

**Market structure tables:** `shareholding_patterns` tracks quarterly promoter/FII/DII/public holding percentages and pledge status. `corporate_actions` records dividends, splits, bonuses, rights issues, and buybacks. `insider_trades` stores promoter and key managerial buy/sell disclosures. `index_constituents` maps companies to indices (Nifty 50, Bank Nifty, sectoral indices) with weights. `macro_indicators` holds monthly RBI rates, inflation figures, GDP growth, PMI, FII/DII flows, and commodity prices. `announcements` stores board meeting dates, AGM notices, and results dates.

**User and system tables:** `watchlists` persists named ticker lists per client. `custom_screens` stores user-defined screening conditions for reuse. `pipeline_status` tracks ingestion run history for each data pipeline. `plugin_registry` is a metadata table that records which tool domains are installed, their version, and their associated database tables.

All schema changes go through numbered migration files. The server runs pending migrations on startup, so deploying a new version with additional tables is automatic.

### Plugin architecture

The server's tool layer is organized as self-contained plugins. Each tool domain (company lookup, financials, valuation, screening, etc.) lives in its own TypeScript file under `src/tools/` and exports a single `registerTools()` function. The server imports and calls each one during startup. Adding a new domain to the server requires exactly four things: a migration file for new tables, an optional ingestion script for the data source, a tool module file, and one import line in `src/server.ts`. Nothing else changes. This is how the server will grow from its current 44 tools to 60, 80, or more without the codebase becoming tangled.

### Security and middleware

API key authentication via bearer tokens. Keys are stored as environment variables, validated on every request. In development mode, auth is optional. Rate limiting uses a Redis-backed sliding window algorithm at 100 requests per minute per client, with 429 responses and Retry-After headers when exceeded. Host header validation prevents DNS rebinding attacks on the Streamable HTTP endpoint. Every tool call is logged with structured JSON (timestamp, client ID, tool name, duration, status) for operational monitoring. All SQL is parameterized through a central query library. Zero string concatenation anywhere in the database layer.

### Response format

Every tool returns responses in a standardized AI-native format designed for LLM consumption rather than raw table dumps. Each response contains four fields: `summary` (a one-sentence human-readable description of what was returned), `data` (the structured payload), `context` (metadata including units, time periods, data freshness timestamps, and disclaimers where applicable), and `relatedTools` (an array of 3-6 tool names the agent might want to call next for deeper analysis). This format means an agent can chain tool calls intelligently without hardcoded orchestration logic.

---

## Complete tool inventory (44 tools across 10 domains)

### Company lookup (5 tools)

`search_companies` performs fuzzy matching on company name with exact matching on ticker and ISIN. Supports filtering by sector, market cap range, and result limit. Uses the Postgres trigram index for sub-100ms response times even across the full 7000-company universe. This is typically the first tool an agent calls when a user mentions a company by name.

`get_company_profile` returns the complete metadata record for a single company: ticker, name, ISIN, sector, industry, market cap, listing date, face value, exchange, latest price, and current key ratios (PE, PB, dividend yield). If the ticker isn't found, it falls back to fuzzy search and suggests close matches in the error response so the agent can self-correct.

`get_company_peers` finds companies in the same industry ranked by market cap proximity. Useful for relative valuation and competitive analysis.

`get_index_constituents` lists all companies in a given index (Nifty 50, Bank Nifty, Nifty IT, Nifty Pharma, etc.) with their index weights.

`get_sector_overview` aggregates statistics for an entire sector: company count, total market cap, average PE/PB/ROE, top gainers, top losers, and the largest companies.

### Financial statements (6 tools)

`get_income_statement` returns annual or quarterly P&L time series: revenue, expenses, operating profit, other income, depreciation, interest, PBT, tax, net profit, EPS. Includes YoY growth percentages for every line item. Configurable year range, defaults to 5.

`get_balance_sheet` returns the same time series structure for balance sheet items: equity capital, reserves, borrowings, other liabilities, fixed assets, CWIP, investments, other assets, total assets.

`get_cash_flow` returns operating, investing, and financing cash flows with a computed free cash flow line (operating cash flow minus capex).

`get_financial_ratios` returns the full precomputed ratio set for a company over time: PE, PB, ROE, ROCE, debt-to-equity, current ratio, dividend yield, operating margin, net margin, asset turnover, interest coverage, earnings yield, FCF yield, and multi-year CAGR figures (3Y, 5Y, 10Y for both revenue and profit).

`get_quarterly_results` returns the last N quarterly results with YoY and QoQ growth calculations. Flags quarters with greater than 20% deviation from the trend line as anomalies.

`compare_financials` places up to 5 companies side by side on any set of financial metrics, with sector averages included for context.

### Valuation (5 tools)

`calculate_dcf` runs a full discounted cash flow model. Uses last 3 years' average free cash flow as the base. Auto-derives growth rate from historical revenue CAGR when the user doesn't specify one. Guardrails prevent the terminal growth rate from exceeding the discount rate. The mandatory output includes a 5x5 sensitivity table varying growth rate and discount rate by +/-2% in 1% steps, producing 25 different intrinsic value estimates. Also returns year-by-year projected cash flows, enterprise value breakdown, and margin of safety versus current price. Every response carries a disclaimer in the context field.

`get_valuation_metrics` returns current multiples alongside their historical context: N-year average, min, max, median, and percentile rank for each metric. The percentile rank immediately tells an agent whether a stock is cheap or expensive relative to its own history.

`calculate_intrinsic_value` runs four independent valuation methods and presents the full range: Graham Number (conservative, based on EPS and book value), Earnings Power Value (normalizes average profits, assumes zero growth), asset-based book value (balance sheet floor), and a 10-year DCF. The spread between the lowest and highest estimate communicates how much uncertainty exists.

`get_historical_valuations` provides year-by-year PE and PB with computed bands (min, max, median) so an agent can identify whether a company's current valuation is at historical extremes.

`valuation_screener` filters the entire company universe by valuation criteria: PE range, PB range, EV/EBITDA range, yield minimums, with sector filtering. Returns ranked results.

### Stock screening (4 tools)

`run_screen` is the core screening engine. It accepts structured conditions like "ROCE > 20 AND Debt to equity < 0.5 AND Sales growth 5Years > 15 AND Market cap > 5000" and translates them to parameterized SQL through a parser that supports 30+ field aliases ("PE" maps to pe_ratio, "return on capital employed" maps to roce, "market cap" maps to market_cap_cr, etc.). The parser handles percentage auto-conversion (input "ROE > 15" becomes a query against 0.15 in the database). Results are sorted by configurable metric with allowlisted column validation to prevent SQL injection in ORDER BY clauses.

`get_preset_screens` provides 10 hardcoded investment screens, each encoding a well-known strategy: Magic Formula (earnings yield + ROIC ranking), Piotroski F-Score 9 (all 9 financial health criteria met), Graham Net-Net (current assets minus total liabilities exceeds market cap), Coffee Can (ROCE above 15% and revenue growth above 10% every year for 10 years), Consistent Compounders (PAT CAGR 10Y above 15%, ROE above 15%, low debt), High Dividend (yield above 3%, payout below 60%, growing profits), Momentum (price above 200-day MA, RSI 50-70, volume surge), Low PE Growth (PE below 15, earnings growth above 20%), Debt-Free (zero borrowings, market cap above 500 crore), and Capacity Expansion (fixed assets doubled in 3 years).

`save_custom_screen` persists user-defined conditions to the database for repeated use.

`backtest_screen` runs a screen historically at each rebalance date, computes equal-weight portfolio returns, and compares against the Nifty 50 benchmark. Returns total return, CAGR, max drawdown, Sharpe ratio, and period-by-period performance.

### Technical analysis (5 tools)

`get_price_history` returns OHLCV data for configurable periods (1 month to max) at daily, weekly, or monthly intervals. Weekly and monthly intervals aggregate from daily data using last-trading-day-of-period logic. Includes computed daily returns and cumulative return series.

`calculate_moving_averages` computes SMA and EMA for any set of periods (defaults to 20, 50, 200 day). Returns current values, crossover signals (golden cross if 50-day crosses above 200-day, death cross for the inverse), and the stock's current price position relative to each moving average.

`calculate_rsi` returns the current RSI value with a signal classification (oversold below 30, overbought above 70, neutral between) and the 30-day RSI history for trend analysis. Configurable period, defaults to 14.

`calculate_macd` returns the MACD line, signal line, and histogram with a crossover signal (bullish crossover, bearish crossover, or neutral). Configurable fast/slow/signal periods.

`get_technical_summary` is the composite tool that combines everything: all moving averages (20/50/200 SMA and EMA), RSI with signal, MACD with crossover state, Bollinger Bands position, volume trend (rising or falling versus 20-day average), support and resistance levels derived from recent swing highs and lows, and an overall signal strength rating on a 5-point scale from "strong sell" to "strong buy" based on how many indicators align.

### Shareholding and insider activity (4 tools)

`get_shareholding_pattern` returns the quarterly breakdown of promoter, FII, DII, public, and government holdings plus pledge percentage over a configurable number of quarters.

`get_shareholding_changes` identifies companies with significant holding changes in the latest quarter: promoter increases/decreases of 1+ percentage points, FII/DII shifts, pledge changes of 0.5+ percentage points.

`get_insider_trades` returns recent promoter and key managerial buy/sell disclosures filterable by company, transaction type, and lookback period. When called without a ticker, returns market-wide insider activity.

`get_bulk_block_deals` shows large institutional trades with a configurable minimum value filter.

### Corporate actions and events (3 tools)

`get_dividends` returns the complete dividend history with aggregate statistics: total dividends paid, average per share, and dividend CAGR.

`get_stock_splits_bonuses` returns all historical splits, bonuses, rights issues, and buybacks with type breakdown and adjustment factors.

`get_upcoming_events` provides a forward-looking calendar of board meetings, AGMs, results dates, and other corporate events. Filterable by ticker, event type, and time horizon.

### Macro and market context (4 tools)

`get_market_overview` provides a real-time market snapshot with no parameters required: proxy index levels for Nifty 50, Sensex, Bank Nifty, and Nifty IT (computed from constituent averages), market breadth (advances/declines/unchanged), latest FII/DII net flows, VIX, and the top 5 gainers and losers by percentage change. Cached for 5 minutes.

`get_macro_indicators` returns a time series of RBI rates (repo, reverse repo), CPI and WPI inflation, GDP and IIP growth, manufacturing and services PMI, USD/INR rate, crude oil price, and gold price. Configurable from 1 to 120 months of history. Cached for 6 hours.

`get_fii_dii_flows` provides daily FII and DII net buy/sell data with cumulative totals and a 5-day trend signal ("FII net buying", "FII net selling", or "Mixed"). Honestly returns null for buy/sell breakdowns when only net values exist in the schema rather than fabricating numbers.

`get_sector_rotation` computes average returns per sector using price history, filtered to companies above 1000 crore market cap to reduce microcap noise. Signal thresholds scale with the time period (2% for 1 week, 5% for 1 month, 10% for 3 months). Returns sectors ranked by momentum with inflow/outflow/neutral classifications.

### Portfolio analytics (4 tools)

`create_watchlist` persists a named list of ticker symbols to the database for tracking.

`analyze_portfolio` accepts a holdings array (ticker, quantity, average price) and computes: total current value, cost basis, unrealized gain/loss, day change, sector exposure weights, concentration risk via the Herfindahl-Hirschman Index with level classifications (diversified below 1500, moderate 1500-2500, concentrated above 2500), largest position weight, a diversification score from 0-100, and per-holding breakdowns. Warns about unrecognized tickers in the input. Not cached since input is user-specific.

`get_portfolio_returns` computes XIRR (using Newton-Raphson iteration from the financial math library), absolute return, holding period, per-stock CAGR, and benchmark comparison against Nifty 50 constituent average returns. Returns null for benchmark fields if data is unavailable rather than approximating.

`suggest_rebalancing` applies rules-based logic to flag concentration risk: any single position above 20% of portfolio weight, any sector above 40% exposure, any holding with a loss exceeding 30% from cost basis, and deviations from target sector weights if provided. Returns priority-sorted suggestions with specific actionable language.

### AI-native research (4 tools)

These tools are fundamentally different from everything else in the server. They pull data from multiple tables, cross-reference it, and compose structured analytical narratives designed for an LLM to relay directly to a human user. They share a common data-fetching helper that queries company profile, ratios, annual financials, quarterly results, price history, and shareholding patterns in parallel.

`explain_company` produces a complete structured understanding of a company in one call: business overview (sector, industry, market cap tier, revenue scale), financial health assessment (strengths and concerns derived mechanically from ratio thresholds, not generated opinions), recent quarterly performance with acceleration/deceleration flags, key metrics snapshot, and investment considerations (bull and bear points). This is the tool an agent should call first when a user says "tell me about Reliance."

`compare_investment_thesis` places 2-5 companies side by side across eight dimensions: scale (revenue, profit, market cap), growth (3Y and 5Y CAGR), profitability (ROE, ROCE, margins), valuation (PE, PB, earnings yield), balance sheet (debt, liquidity), cash flow (FCF, FCF yield), shareholding quality (promoter holding, pledge status), and price momentum (1M, 3M, 1Y returns). Each dimension flags the leader with a mechanically generated summary sentence.

`generate_research_report` assembles a full equity research template at three depth levels. Brief (3 sections: snapshot, financial highlights, quick take). Standard (7 sections: adds business overview, 5-year financial analysis with trend assessment, valuation with DCF and Graham number, shareholding analysis). Deep (10 sections: adds quarterly trend with anomaly detection, peer comparison, technical overview with moving averages and RSI). Each section is structured data, not prose paragraphs. The agent formats the narrative, the server provides the numbers and labels.

`ask_about_data` translates natural language questions to SQL queries against the database. It maps 15-20 common question patterns ("which IT companies have ROE above 20%", "top 10 by revenue growth", "how many companies have zero debt", "average PE of Nifty 50 companies") to parameterized SQL templates. This is the escape valve for anything the other 43 tools don't cover explicitly.

---

## MCP resources and prompts

Beyond tools, the server exposes 5 MCP resources (read-only data URIs that clients can list and fetch) and 4 MCP prompts (reusable interaction templates).

Resources provide direct URI-based access to company profiles (`equity://company/{ticker}`), annual and quarterly financials (`equity://financials/{ticker}/annual`, `equity://financials/{ticker}/quarterly`), the current market snapshot (`equity://market/overview`), and latest macro indicators (`equity://macro/latest`).

Prompts guide multi-step agent workflows: `investment-analysis` orchestrates a company deep-dive using explain_company, financial_ratios, DCF, and technical_summary. `screen-builder` walks the user through building screening criteria step by step. `portfolio-review` chains portfolio analysis, return calculation, and rebalancing suggestions. `sector-deep-dive` combines sector overview, rotation data, and company-level analysis for the sector's top constituents.

---

## Data ingestion infrastructure

Eight automated pipelines handle pulling data from external sources into the database. Each pipeline implements a primary/fallback source pattern: if the primary source fails (common with NSE/BSE direct endpoints), the pipeline automatically tries a secondary source. All inserts use ON CONFLICT DO UPDATE for idempotency, meaning pipelines can be rerun safely at any time. Per-company error logging prevents a single failed company from aborting the entire batch. Pipeline execution status (last run time, records processed, errors) is tracked in the pipeline_status table.

A manual CSV import pipeline also exists for bulk loading screener.in Excel exports, which is the most reliable data source for historical Indian financial data. This pipeline handles two formats: a bulk screen export (one CSV, many companies, latest snapshot) and individual per-company Excel exports (multi-year P&L, balance sheet, cash flow, ratios).

---

## Testing

56 unit tests across 4 test files covering the financial math library (CAGR, XIRR, DCF, Piotroski score, Graham number, SMA, EMA, RSI, MACD with normal, edge, and error cases), the screen condition parser (structured condition parsing, percentage auto-conversion, alias matching, operator handling, sort validation, error reporting), the response builder (output formatting, ticker normalization, Indian number formatting), and cache utilities (key generation, TTL validation). All pass cleanly under Vitest.

---

## Deployment readiness

Deployment configs exist for Railway (railway.toml with build/start commands and health checks) and Fly.io (fly.toml configured for Mumbai region, auto-stop/start for cost efficiency, single-instance per the session management design). A GitHub Actions CI pipeline runs type checking and tests on every push and pull request. A comprehensive DEPLOYMENT.md documents the full setup for both platforms, environment variable reference, known limitations, and client connection configs for Claude Desktop, Claude Code, Cursor, and VS Code.

---

## Documentation

Four reference documents ship with the project: TOOL_CATALOG.md (all 44 tools with descriptions, inputs, outputs, and examples), EXTENDING.md (step-by-step guide for adding new tool domains with code examples), DATA_SOURCES.md (where each data field comes from, source reliability ratings, update frequencies), and DEPLOYMENT.md (local and cloud deployment instructions).

---

## Current status and what remains

The software is code-complete. All 44 tools across 10 plugins compile clean and are registered with the MCP server. Middleware (auth, rate limiting, logging, host validation, input validation) is in place. Deployment configs are generated. Tests pass. Documentation is written.

The remaining work is operational, not development. Data needs to be populated using either the CSV import pipeline (from screener.in exports, manually collected) or by fixing the automated ingestion pipelines to use a paid data API. After data is in, the server deploys with a single command to Railway or Fly.io, gets a public URL, and any MCP client can connect immediately.

---

## Future extensibility

The plugin architecture means the following can each be added as isolated modules without touching existing code:

ESG and sustainability scores. Management commentary analysis using vector embeddings for semantic search over annual report text. News sentiment scoring from RSS feeds. Consensus analyst estimates and earnings surprise tracking. Mutual fund holdings showing which funds own which stocks and position changes. Credit rating history from CRISIL, ICRA, and CARE. Commodity price tracking for companies with exposure. Global peer comparison against international listed companies. Event-driven MCP notifications when screening conditions trigger. Chart generation returning SVG or PNG visualizations as MCP resources.

Each requires a migration file, an optional ingestion script, a tool module, and one import line. The pattern is established and documented. The server is designed to grow.
