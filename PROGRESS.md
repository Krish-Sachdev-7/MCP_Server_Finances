# Build Progress

Read this file at the START of every Cowork session to know where you left off.
Also read the "Known risks and mitigations" section in SKILL.md before each phase.

## Phase 0: Infrastructure verification -- MUST BE DONE BY HUMAN
- [x] `docker compose up -d` -- postgres and redis healthy
- [x] `npm install` -- no errors
- [x] `npm run db:migrate` -- tables created
- [x] `npx tsx scripts/seed.ts` -- seed data loaded
- [x] `TRANSPORT=http npx tsx src/index.ts` -- health endpoint returns healthy
- [x] Stop server, leave Docker running, hand to Cowork

## Phase 1: Scaffold -- COMPLETE
- [x] package.json with all dependencies
- [x] tsconfig.json (ESM, strict, Node16)
- [x] docker-compose.yml (Postgres 16 + Redis 7)
- [x] Dockerfile (multi-stage production build)
- [x] .env.example
- [x] Database schema (001_initial_schema.sql) -- 14 tables, indexes, trigram extension
- [x] DB connection pool (src/db/connection.ts)
- [x] Migration runner (src/db/migrate.ts)
- [x] Query library (src/db/queries.ts) -- parameterized queries for all domains
- [x] Redis cache client (src/cache/redis.ts) -- typed helpers, TTL presets
- [x] Auth middleware (src/middleware/auth.ts) -- bearer token validation
- [x] Rate limiter (src/middleware/rate-limit.ts) -- Redis sliding window
- [x] Structured logger (src/middleware/logger.ts) -- pino with pretty dev output
- [x] Financial math utils (src/utils/financial-math.ts) -- CAGR, XIRR, DCF, Piotroski, SMA, EMA, RSI, MACD
- [x] Response builder (src/utils/response-builder.ts) -- AI-native output formatting
- [x] Screen parser (src/utils/screen-parser.ts) -- NL conditions to parameterized SQL
- [x] MCP server (src/server.ts) -- plugin-based tool registration
- [x] Entry point (src/index.ts) -- Streamable HTTP + stdio + health check + graceful shutdown
- [x] Company tools (src/tools/company.ts) -- REFERENCE IMPLEMENTATION with 5 tools
- [x] Ingestion runner (src/ingestion/runner.ts) -- pipeline orchestration framework
- [x] All remaining tool stubs created

## Phase 2: Data ingestion -- COMPLETE
- [x] Shared ingestion utilities (src/ingestion/utils.ts) -- HTTP fetcher with retry, rate limiter, CSV parser, helpers
- [x] Company master list pipeline (src/ingestion/companies.ts) -- NSE primary, BSE fallback, index constituents
- [x] Financial statements pipeline (src/ingestion/financials.ts) -- Yahoo Finance primary, annual + quarterly + ratios
- [x] Price history pipeline (src/ingestion/prices.ts) -- Yahoo Finance, 10yr backfill, incremental daily
- [x] Shareholding pipeline (src/ingestion/shareholding.ts) -- BSE shareholding filings, quarterly
- [x] Corporate actions pipeline (src/ingestion/corporate-actions.ts) -- BSE primary, NSE fallback
- [x] Insider trades pipeline (src/ingestion/insider-trades.ts) -- NSE SAST primary, BSE fallback
- [x] Macro indicators pipeline (src/ingestion/macro.ts) -- RBI/govt sources, hardcoded fallback
- [x] Seed data CSV files (data/seeds/companies_seed.csv) -- 100 companies across sectors
- [x] Seed loading script (scripts/seed.ts) -- all domains: companies, financials (annual+quarterly), ratios, prices, shareholding, corporate actions, insider trades, macro indicators, index constituents
- [x] All pipelines wired up in runner.ts with dynamic imports
- [x] All ingestion files compile with zero TypeScript errors
- [x] RISK CHECK: Every pipeline has fetchFromPrimary() + fetchFromFallback() pattern (except shareholding which has no fallback per spec)
- [x] RISK CHECK: All pipelines use ON CONFLICT DO UPDATE for idempotent/resumable runs
- [x] RISK CHECK: Did any primary sources fail? (requires live infrastructure to test) -- companies returned no NSE/BSE records; prices failed due DB schema/query mismatch (`symbol` column missing)
- [ ] RISK CHECK: Can pipelines resume after interruption? (requires live infrastructure to test)

## Phase 3: Tools -- COMPLETE (44 tools across 10 plugins)
- [x] Company tools (5 tools) -- COMPLETE, reference implementation
- [x] Financial tools (6 tools) -- src/tools/financials.ts [Session 1]
- [x] Valuation tools (5 tools) -- src/tools/valuation.ts [Session 2] -- disclaimers included, 5x5 sensitivity table in DCF, multi-method intrinsic value
- [x] Screening tools (4 tools) -- src/tools/screening.ts [Session 3] -- run_screen, get_preset_screens (10 presets), save_custom_screen, backtest_screen
- [x] Technical tools (5 tools) -- src/tools/technicals.ts [Session 4] -- get_price_history (period conversion, weekly/monthly aggregation), calculate_moving_averages (SMA/EMA with golden/death cross), calculate_rsi (14-period, overbought/oversold), calculate_macd (crossover detection, trend strength), get_technical_summary (all indicators combined, Bollinger Bands, volume trend, support/resistance, overall signal rating)
- [x] Shareholding tools (4 tools) -- src/tools/shareholding.ts [Session 5] -- get_shareholding_pattern (quarterly breakdown with trends), get_shareholding_changes (quarter-over-quarter diffs with significant move detection), get_insider_trades (SAST disclosures, market-wide or per-ticker), get_bulk_block_deals (large-value institutional trades)
- [x] Corporate action tools (3 tools) -- src/tools/corporate-actions.ts [Session 5] -- get_dividends (full dividend history with stats), get_stock_splits_bonuses (splits/bonus/rights/buyback history), get_upcoming_events (forward-looking calendar with type filter)
- [x] Macro tools (4 tools) -- src/tools/macro.ts [Session 6] -- get_market_overview (index proxies, breadth, FII/DII flows, top gainers/losers), get_macro_indicators (repo rate, CPI/WPI, GDP, PMI, USD/INR, crude, gold time series), get_fii_dii_flows (daily net flows with cumulative totals and trend signal), get_sector_rotation (period-based sector returns ranking with inflow/outflow signals)
- [x] Portfolio tools (4 tools) -- src/tools/portfolio.ts [Session 6] -- create_watchlist (upsert named ticker lists), analyze_portfolio (value, gain/loss, sector exposure, HHI concentration, diversification score), get_portfolio_returns (XIRR, absolute return, per-stock CAGR, benchmark comparison), suggest_rebalancing (rules-based trim/overweight/loss/rebalance suggestions)
- [x] AI-native tools (4 tools) -- src/tools/ai-native.ts [Session 7] -- ask_about_data (15 NL query patterns), explain_company (multi-table structured company narrative with financial health assessment, investment considerations, data freshness), compare_investment_thesis (2-5 company side-by-side across 8 dimensions: scale, growth, profitability, valuation, balance sheet, cash flow, shareholding, momentum), generate_research_report (3 depth levels: brief/standard/deep with DCF, peer comparison, technicals)
- [x] AI-native plugin registration refactored: ask_about_data moved from screening.ts hack to standalone ai-native.ts plugin. screening.ts no longer imports ai-native.ts. All 10 plugins registered independently in server.ts.
- [x] RISK CHECK: Do all tools match company.ts pattern? (try/catch, cache, buildResponse, normalizeTicker) -- YES, verified across all 10 tool files. Portfolio tools skip caching as specified (user-specific input). AI-native tools use caching where appropriate (explain, compare, report) and skip where not (portfolio-style inputs).
- [x] RISK CHECK: Are all descriptions under 200 words with action verb -> returns -> when to use -> example? -- YES, all descriptions follow the structure.
- [x] RISK CHECK: Do valuation tools include disclaimers in context field? -- YES, 11 disclaimer references in valuation.ts. generate_research_report also includes disclaimer.
- [x] RISK CHECK: Do run_screen and ask_about_data descriptions clearly distinguish their use cases? -- YES, each description explicitly routes to the other

## Phase 4: Middleware -- COMPLETE
- [x] Authentication
- [x] Rate limiting
- [x] Structured logging
- [x] Input validation (Zod on each tool)
- [x] Host header validation for DNS rebinding protection -- src/middleware/host-validation.ts [Session 8]. Validates Host header on all /mcp routes via app.use('/mcp', validateHost). Dev mode permissive, production checks ALLOWED_HOSTS env var (comma-separated). Rejects mismatches with 403.

## Phase 5: Deployment -- COMPLETE
- [x] Dockerfile
- [x] docker-compose.yml
- [x] Railway deployment config (railway.toml) [Session 8] -- build/start commands, health check, on-failure restart
- [x] Fly.io deployment config (fly.toml) [Session 8] -- bom region, auto-stop/start, single instance per Risk 5
- [x] CI/CD pipeline (.github/workflows/ci.yml) [Session 8] -- checkout, Node 20, npm ci, tsc --noEmit, npm test
- [x] Production environment variable documentation (docs/DEPLOYMENT.md) [Session 8] -- env var reference table, Railway + Fly.io step-by-step, Claude Desktop/Cursor/VS Code connection configs
- [x] Document in-memory session limitation in DEPLOYMENT.md (see Risk 5) [Session 8]
- [ ] Verify Postgres indexes handle uncached screening queries in <500ms (see Risk 6) -- requires live infrastructure

## Phase 6: Resources + Prompts -- COMPLETE
- [x] MCP resources (5 resources: 2 static + 3 URI templates) [Session 8] -- market-overview (equity://market/overview), macro-latest (equity://macro/latest), company-profile (equity://company/{ticker}), annual-financials (equity://financials/{ticker}/annual), quarterly-financials (equity://financials/{ticker}/quarterly). All 5 registered including URI templates via ResourceTemplate class.
- [x] MCP prompts (4 prompts) [Session 8] -- investment-analysis (ticker arg), screen-builder (no args), portfolio-review (holdings JSON arg), sector-deep-dive (sector arg). Registered via server.prompt() with Zod arg schemas.
- [x] Resources and prompts wired into server.ts after tool plugin registration.

## Phase 7: Testing + Docs -- IN PROGRESS
- [x] Unit tests for financial-math.ts
- [x] Unit tests for screen-parser.ts
- [x] Unit tests for cache utilities (src/cache/redis.ts)
- [x] Unit tests for response-builder.ts
- [ ] Integration tests for MCP server
- [x] README.md
- [x] TOOL_CATALOG.md
- [x] DEPLOYMENT.md
- [x] EXTENDING.md
- [x] DATA_SOURCES.md

## Post-build validation (AFTER all phases complete)
- [ ] Agent test: Ask Claude "compare HDFC Bank and ICICI Bank financial health over 5 years" -- does it pick the right tools?
- [ ] Agent test: Ask "find undervalued pharma companies with low debt" -- does it route to run_screen or ask_about_data correctly?
- [ ] Agent test: Ask for a DCF valuation -- does the response include sensitivity table and disclaimer?
- [ ] Performance test: Run a complex screen (5+ conditions) -- does it respond in <500ms with cache, <2s without?
- [ ] Resilience test: Stop Redis, run a screen query -- does the server still respond (slower but functional)?
- [ ] Resilience test: Kill the ingestion pipeline mid-run, restart -- does it resume from where it left off?
