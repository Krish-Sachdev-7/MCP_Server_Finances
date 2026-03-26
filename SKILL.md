# EquityMCP — Master Project Specification

## Project identity

**Name:** EquityMCP
**Purpose:** A production-grade MCP (Model Context Protocol) server exposing financial data for ~7000 Indian listed companies to AI agents over the network.
**Analogy:** screener.in as an API, purpose-built for LLMs and AI agents.
**Transport:** Streamable HTTP (primary), SSE fallback (legacy clients), stdio (local dev).
**Stack:** TypeScript, Node.js, PostgreSQL, Redis, @modelcontextprotocol/sdk v2.x, Zod.

---

## Architectural principles

### 1. Plugin-first extensibility
Every domain (financials, technicals, macro, etc.) is a self-contained plugin module. Adding a new data domain later (qualitative data, ESG scores, management commentary, news sentiment, analyst estimates, mutual fund holdings) means creating a new file in `src/tools/`, registering its tools in `src/server.ts`, and adding its DB tables via a migration. No existing code changes required.

**Plugin contract:** Every tool module exports a single function `registerTools(server: McpServer, db: Pool, cache: RedisClient)` that registers its tools with the MCP server. The server.ts file imports and calls each one. To add a new domain:
1. Create `src/tools/your-domain.ts`
2. Export `registerTools()`
3. Add one line to `src/server.ts`: `import { registerTools as registerYourDomain } from './tools/your-domain.js'; registerYourDomain(server, db, cache);`
4. Add migration in `src/db/migrations/` for new tables
5. Add ingestion script in `src/ingestion/` if needed

### 2. Schema evolution via migrations
All DB changes go through numbered migration files (`001_initial.sql`, `002_add_esg.sql`, etc.). Never modify an existing migration. The server runs pending migrations on startup.

### 3. Parameterized everything
Zero string concatenation in SQL. Every query uses parameterized placeholders. The `src/db/queries.ts` file is the single source of truth for all SQL. Tools call query functions, never write raw SQL.

### 4. Cache-first for hot data
Redis caches: company profiles (1 hour TTL), latest prices (5 min TTL), screen results (15 min TTL), macro indicators (6 hour TTL). Cache keys follow the pattern `equity:{domain}:{identifier}:{params_hash}`. Cache invalidation happens on ingestion.

### 5. AI-native output formatting
Tool responses are optimized for LLM consumption. Not raw table dumps. Each response includes:
- `summary`: A one-sentence human-readable summary of the result
- `data`: The structured data payload
- `context`: Helpful metadata (units, time periods, data freshness)
- `related_tools`: Suggestions for what the agent might want to call next

### 6. Defensive input handling
Every tool input is validated with Zod schemas. Tool descriptions include explicit examples of valid inputs. Invalid inputs return clear error messages that help the AI agent self-correct. Ticker symbols are normalized (uppercase, trimmed, with exchange suffix handling).

---

## Known risks and mitigations

This section documents problems that WILL arise during the build. Read this before starting each phase so you can recognize and handle issues instead of spiraling.

### RISK 1: Data sourcing instability (Phase 2 — HIGHEST RISK)
NSE and BSE do not offer stable, documented public APIs. What exists are undocumented internal JSON endpoints their websites consume. These break without notice — URL structures change, CAPTCHAs get added, session tokens rotate, IPs get blocked at moderate request volumes.

**Mitigation — source abstraction with fallback chain:**
Every ingestion pipeline MUST implement a `fetchFromPrimary()` and `fetchFromFallback()` pattern. If the primary source (NSE/BSE direct) fails or returns garbage, the pipeline automatically falls back to the secondary source without manual intervention.

**Fallback priority per data type:**
- **Company list:** Primary: NSE bhavcopy. Fallback: BSE listing CSV download.
- **Financials:** Primary: BSE filing pages. Fallback: Yahoo Finance fundamentals via `.NS` tickers.
- **Prices:** Primary: Yahoo Finance (most stable for Indian equities). No fallback needed — Yahoo is reliable.
- **Shareholding:** Primary: BSE shareholding filings. Fallback: None (BSE is the only source; if it fails, log and retry next cycle).
- **Corporate actions / insider trades:** Primary: NSE corporate announcements. Fallback: BSE corporate actions page.
- **Macro indicators:** Primary: RBI data portal. Fallback: Hardcoded manual updates (these change monthly at most).

**If free sources prove too unreliable**, consider paid APIs early rather than sinking days into scraping workarounds:
- Financial Modeling Prep ($29/month) — covers Indian stocks
- EODHD ($20/month) — Indian fundamental data + prices
- Twelve Data (free tier) — prices and basic fundamentals

The tool layer is completely isolated from the data source by queries.ts. Swapping a data source means changing ONLY the ingestion pipeline — zero tool code changes.

### RISK 2: Cowork context loss between sessions (Phase 3 — HIGH RISK)
Cowork's context window resets between sessions. Midway through implementing a tool domain, it may produce tools that subtly diverge from the reference pattern: different error handling, missing cache checks, inconsistent response formats, wrong Zod schema conventions.

**Mitigation — session discipline protocol:**
- **Never implement more than one tool domain per session.** Finish financials.ts, verify it compiles and matches the pattern, then start a fresh session for valuation.ts.
- **At the start of EVERY session**, tell Cowork: "Read PROGRESS.md, then read src/tools/company.ts — this is the reference pattern. Every tool you write must match this structure exactly. Now read the stub file you're working on and implement it."
- **After each tool domain is complete**, diff it against company.ts visually. Check for: (1) try/catch wrapping every handler, (2) cache check before DB query, (3) buildResponse() used for output, (4) buildErrorResponse() used for errors, (5) relatedTools populated, (6) normalizeTicker() called on all ticker inputs.
- If drift is detected, paste a specific tool from company.ts into the chat and say: "This is the canonical pattern. Rewrite the tools in [file] to match this structure exactly."

### RISK 3: Screen parser edge cases (Phase 3 — MEDIUM RISK)
The screen parser in `src/utils/screen-parser.ts` handles clean structured conditions like "ROCE > 20 AND PE < 15" but real queries from AI agents will be messier: "companies with high ROE and low debt in the pharma sector", or "stocks trading below book value with growing profits." The gap between what the parser handles and what agents send is significant.

**Mitigation — two-tool routing strategy:**
- `run_screen` handles ONLY structured quantitative conditions with explicit operators. Its description MUST say: "Use this for precise numeric screening with explicit conditions like 'ROCE > 20 AND PE < 15'. For natural language questions, use ask_about_data instead."
- `ask_about_data` handles fuzzy natural language queries by mapping them to SQL constructs. Its description MUST say: "Use this for exploratory questions in plain English like 'which pharma companies have low debt and high growth'. For precise numeric screening, use run_screen instead."
- The two tools complement each other. Make their descriptions clearly distinguish when to use which — agents pick tools based on descriptions alone.

### RISK 4: 15-year backfill volume (Phase 2 — MEDIUM RISK)
Pulling 7000 companies × 15 years of annual data × 60 quarters of quarterly data from free sources means tens of thousands of API calls. At 3-5 requests/second with rate limiting, that's hours of continuous fetching. Network hiccups, rate limit spikes, or source outages mean partial datasets.

**Mitigation — incremental backfill strategy:**
- Build all tools against seed data first (20 companies, 5 years). Get the server fully functional with sample data BEFORE attempting the full backfill.
- Backfill in tiers: Nifty 500 companies first (the ones people actually ask about), then expand to the full universe.
- Store ingestion progress per-company in the `pipeline_status` table. The schema already has this table. Use it to track which companies have been successfully ingested so you can resume from where you left off after any failure.
- Each pipeline's `run()` function MUST be idempotent and resumable. Use `ON CONFLICT DO UPDATE` for all inserts.

### RISK 5: In-memory session management in production (Phase 5 — LOW RISK)
The index.ts stores MCP sessions in an in-memory `Map`. If the server restarts (deploy, crash, scaling event), all active sessions are lost and clients must reconnect.

**Mitigation — accept it for now, plan for later:**
For single-instance deployments (Railway, single Fly.io machine), this is fine. MCP sessions are ephemeral by design, and well-built clients reconnect automatically. Only if you need horizontal scaling with multiple instances would you need Redis-backed session storage or sticky-session load balancing. Cross that bridge when you hit it. Document this limitation in DEPLOYMENT.md.

### RISK 6: Redis failure degrades screening performance (Production — LOW RISK)
The cache layer fails open — cache miss means DB query. But if Redis dies entirely, every request hits Postgres. Complex screening queries across 7000 companies with multi-column WHERE clauses will slow from ~100ms to 2-5 seconds.

**Mitigation — ensure Postgres indexes are solid:**
The schema already has indexes on all screening-relevant columns (pe_ratio, roe, roce, debt_to_equity, piotroski_score, market_cap_cr). Even without cache, well-indexed queries on this dataset size should stay under 500ms. If specific screens are slow after deployment, add `EXPLAIN ANALYZE` logging to identify missing indexes and add targeted composite indexes via new migration files.
Monitor the `/health` endpoint — it already reports cache status. On Railway/Fly.io, Redis restarts automatically.

### RISK 7: DCF and valuation tools producing overconfident numbers (Phase 3 — MEDIUM RISK)
A DCF model with default assumptions outputs a single intrinsic value that looks authoritative. AI agents present it as fact. Users treat it as investment advice.

**Mitigation — mandatory disclaimers and sensitivity output:**
- The `calculate_dcf` tool MUST always return the 5×5 sensitivity table (varying growth rate ±2% and discount rate ±2%). This shows how fragile the estimate is.
- The `context` field in every valuation tool response MUST include: `"disclaimer": "This is a mechanical calculation based on historical data and assumed growth rates. It is not investment advice. Actual outcomes depend on factors not captured in this model."`
- The `calculate_intrinsic_value` tool MUST return multiple methods (Graham, EPV, asset-based) so the range of estimates is visible.
- Tool descriptions for all valuation tools MUST include: "Results are illustrative calculations, not investment recommendations."

### RISK 8: Tool description quality affecting agent behavior (Phase 3 — MEDIUM RISK)
AI agents choose tools based entirely on the description string from `listTools`. Vague descriptions cause wrong tool selection. Overly verbose descriptions (500+ words) fill the agent's context with metadata and degrade reasoning quality.

**Mitigation — description constraints:**
- Every tool description MUST be under 200 words.
- Every description MUST follow this structure: action verb → what it returns → when to use → when NOT to use → one concrete example call.
- After all 44 tools are built, run a validation test: ask Claude to do complex multi-step tasks ("compare HDFC Bank and ICICI Bank's financial health over 5 years") and observe which tools it selects. If it picks wrong tools, the descriptions need editing — not the tool logic.
- The company.ts reference implementation has calibrated descriptions. Match their style exactly.

### RISK 9: Docker/Postgres setup failures blocking Cowork (Phase 1 — PRE-BUILD)
Running `docker compose up` and `npm run db:migrate` requires Docker to be running, ports 5432/6379 to be free, and migration SQL to execute without errors. If Cowork encounters a Docker error or port conflict, it will spiral into debugging infrastructure instead of writing application code.

**Mitigation — human does infrastructure, Cowork does code:**
Before handing the project to Cowork, the human operator MUST:
1. Run `docker compose up -d` and verify both services are healthy
2. Run `npm install` and verify no dependency errors
3. Run `npm run db:migrate` and verify tables are created
4. Run `npx tsx scripts/seed.ts` and verify sample data loads
5. Run `TRANSPORT=http npx tsx src/index.ts` and verify `http://localhost:3000/health` returns `{"status":"healthy"}`
6. Only THEN hand the project to Cowork with: "Infrastructure is running. Start coding from Phase 2."

---

## Realistic ETA for Cowork execution

**Total estimate: 8-14 hours of Cowork runtime across 6-10 sessions.**

Cowork has context window limits and will lose track of the full codebase in a single session. Plan for session-per-phase work:

| Phase | Cowork sessions | Estimated time | Notes |
|-------|----------------|----------------|-------|
| 1. Scaffold + DB schema | 1 session | 45-60 min | Straightforward boilerplate |
| 2. Data ingestion pipelines | 2-3 sessions | 2-3 hours | Network calls, error handling, rate limiting. Cowork needs internet access. Most time-intensive phase due to dealing with external API quirks. |
| 3. Core tools (40+) | 3-4 sessions | 3-5 hours | Largest code volume. Break into sub-phases: company+financials, valuation+screening, technicals+shareholding, macro+portfolio+AI-native. |
| 4. Middleware + security | 1 session | 30-45 min | Well-defined patterns |
| 5. Transport + deployment | 1 session | 45-60 min | Docker, config files |
| 6. Resources + prompts | 1 session | 30-45 min | Light layer on top of existing tools |
| 7. Testing + docs | 1-2 sessions | 1-2 hours | Integration tests need running DB |

**Critical path items that may slow things down:**
- External API rate limits during ingestion (NSE/BSE endpoints throttle aggressively) — see Risk 1. If this blocks progress for more than 30 minutes, pivot to Yahoo Finance fallback and move on.
- Cowork losing context between sessions — see Risk 2. Strict one-domain-per-session discipline prevents compounding drift.
- PostgreSQL setup — see Risk 9. Human operator MUST verify infra before handing to Cowork.
- Data volume — 7000 companies x 15 years of quarterly data is ~420K rows per table — see Risk 4. Backfill in tiers, not all at once.
- Screen parser edge cases — see Risk 3. Don't over-engineer the parser. Route fuzzy queries to ask_about_data instead.

**Realistic total with interruptions and debugging: 2-3 calendar days of intermittent Cowork work.**
**Worst case with data source failures requiring fallback rewrites: 4-5 calendar days.**

---

## Cowork setup instructions

### Prerequisites on your machine
1. **Claude Desktop app** — latest version, Pro/Max subscription
2. **Docker Desktop** — running (for Postgres + Redis)
3. **Node.js 20+** — installed globally
4. **Git** — installed

### CRITICAL: Human does infrastructure first (see Risk 9)
Before giving this project to Cowork, YOU must verify the infrastructure works:
1. `docker compose up -d` — both postgres and redis containers healthy
2. `npm install` — no dependency errors
3. `npm run db:migrate` — tables created successfully (check with `docker exec -it equity-mcp-postgres-1 psql -U equitymcp -c '\dt'`)
4. `npx tsx scripts/seed.ts` — sample data loads (check: "Seed complete" in output)
5. `TRANSPORT=http npx tsx src/index.ts` — hit `http://localhost:3000/health`, confirm `{"status":"healthy","database":"connected","cache":"connected"}`
6. Stop the server (Ctrl+C), leave Docker containers running
7. NOW hand the project to Cowork

If any of these steps fail, debug them yourself. Cowork is good at writing application code. It is bad at debugging Docker networking, port conflicts, and OS-level permission issues. Don't waste its context window on infrastructure problems.

### Setting up the project in Cowork
1. Copy this entire `equity-mcp/` folder to a location on your desktop (e.g., `~/Projects/equity-mcp/`)
2. Open Claude Desktop app
3. Switch to **Cowork** mode (sidebar tab)
4. Click **"Work in a folder"** and select `~/Projects/equity-mcp/`
5. Cowork now has read/write access to everything in that folder

### Starting the build
After you have verified infrastructure works (see above), tell Cowork:
```
Read SKILL.md carefully — especially the "Known risks and mitigations" section.
Then read PROGRESS.md to see current status.
This is a large MCP server project for Indian equity data.
Phase 1 is already scaffolded. Infrastructure is running (Postgres + Redis via Docker).
Review what exists, then begin Phase 2: data ingestion pipelines.
Work autonomously. Test each phase before moving to the next.
Update PROGRESS.md as you complete each item.
```

### Between sessions
If Cowork loses context (new session, app restart), tell it:
```
Read PROGRESS.md first to see where you left off.
Then read the "Known risks and mitigations" section in SKILL.md.
If you're working on Phase 3 tools, read src/tools/company.ts FIRST
as the reference pattern before touching any other tool file.
Check src/server.ts to see which tool plugins are already registered.
Continue from where you left off. Work on ONE tool domain at a time.
```

### Giving Cowork network access
Cowork can make HTTP requests to external APIs for the ingestion phase. No special config needed — it inherits your machine's network. If you're behind a VPN or firewall, make sure NSE/BSE/Yahoo Finance endpoints are accessible.

---

## Phase 1: Project scaffold and data model (PRE-BUILT)

This phase is already complete in the scaffolded files. It includes:
- `package.json` with all dependencies
- `tsconfig.json` configured for Node16 ESM
- `docker-compose.yml` for Postgres + Redis
- `src/db/migrations/001_initial_schema.sql` — full database schema
- `src/db/connection.ts` — Postgres pool management
- `src/db/migrate.ts` — migration runner
- `src/cache/redis.ts` — Redis client with typed helpers
- `src/index.ts` — entry point with transport setup
- `src/server.ts` — MCP server with placeholder tool registration
- `src/middleware/auth.ts` — API key authentication
- `src/middleware/rate-limit.ts` — per-client rate limiting
- `src/middleware/logger.ts` — structured request logging
- `src/utils/financial-math.ts` — CAGR, XIRR, DCF, Piotroski score calculations
- `src/utils/response-builder.ts` — standardized AI-native response formatting

**Verify Phase 1:** Run `npm install && npm run build`. Should compile with zero errors.

---

## Phase 2: Data ingestion pipelines

### Architecture
Each ingestion script lives in `src/ingestion/` and follows this interface:

```typescript
interface IngestPipeline {
  name: string;
  schedule: string; // cron expression
  run(db: Pool, options?: IngestOptions): Promise<IngestResult>;
}

interface IngestResult {
  recordsProcessed: number;
  recordsInserted: number;
  recordsUpdated: number;
  errors: string[];
  durationMs: number;
}
```

### Pipeline specifications

**companies.ts** — Master company list
- Source: NSE equity bhavcopy + BSE listing data
- Frequency: Weekly (new listings are rare)
- Fields: symbol, companyName, isin, sector, industry, marketCap, listingDate, faceValue
- Deduplication: ISIN is the primary key across exchanges
- Should handle ~7000 records
- Also populate `index_constituents` table from NSE index pages

**financials.ts** — Annual and quarterly financial statements
- Source: Publicly available JSON endpoints similar to screener.in's data format, or parsed from BSE/NSE filing pages
- Frequency: Weekly (catches new quarterly results)
- Must handle standalone vs consolidated numbers (prefer consolidated when available)
- Fields per period: revenue, expenses, operatingProfit, otherIncome, depreciation, interestExpense, profitBeforeTax, taxExpense, netProfit, eps, equity, reserves, borrowings, totalAssets, totalLiabilities
- 15-year annual history, 40-quarter history where available
- Compute derived ratios on insert: PE, PB, ROE, ROCE, debtToEquity, currentRatio, dividendYield, operatingMargin, netMargin

**prices.ts** — Daily OHLCV price data
- Source: Yahoo Finance India (`.NS` suffix for NSE, `.BO` for BSE)
- Frequency: Daily after market close (4:30 PM IST, cron: `0 16 * * 1-5`)
- Fields: date, open, high, low, close, adjClose, volume
- Historical backfill: 10 years on first run
- Incremental: last trading day only on subsequent runs
- Handle stock splits/bonuses by using adjusted close

**shareholding.ts** — Quarterly shareholding patterns
- Source: BSE shareholding pattern filings
- Frequency: Quarterly (within 21 days of quarter end)
- Fields: promoterHolding, fiiHolding, diiHolding, publicHolding, pledgedPercentage
- Track quarter-over-quarter changes

**corporate-actions.ts** — Dividends, splits, bonuses
- Source: BSE corporate actions page
- Frequency: Weekly
- Fields: actionType (dividend/split/bonus/rights), exDate, recordDate, details, value

**insider-trades.ts** — Promoter buy/sell
- Source: NSE insider trading disclosures
- Frequency: Daily
- Fields: company, insiderName, relationship, transactionType, shares, value, date

**macro.ts** — Macroeconomic indicators
- Source: RBI data portal, government statistics
- Frequency: Monthly
- Fields: repoRate, reverseRepoRate, cpi, wpi, gdpGrowth, iip, pmi, usdInrRate
- Historical: 10 years

### Error handling for ingestion
- Retry with exponential backoff (3 attempts, 1s/4s/16s delays)
- Log failures per-company, don't abort the entire batch
- Store last successful ingest timestamp per pipeline in a `pipeline_status` table
- Rate limit external API calls: max 5 requests/second to NSE, 3/second to BSE

### Source fallback pattern (MANDATORY — see Risk 1)
Every pipeline MUST implement this pattern:
```typescript
async function fetchCompanyData(ticker: string): Promise<CompanyData> {
  try {
    return await fetchFromPrimary(ticker); // e.g. NSE direct endpoint
  } catch (primaryErr) {
    logger.warn({ ticker, err: primaryErr }, 'Primary source failed, trying fallback');
    try {
      return await fetchFromFallback(ticker); // e.g. Yahoo Finance
    } catch (fallbackErr) {
      logger.error({ ticker, primaryErr, fallbackErr }, 'All sources failed');
      throw new Error(`All sources failed for ${ticker}`);
    }
  }
}
```
If you hit persistent failures on NSE/BSE direct endpoints (CAPTCHAs, IP blocks, URL changes), pivot the primary source to Yahoo Finance and move on. Do NOT spend hours debugging scraping — the tool layer doesn't care where the data comes from.

### Incremental backfill strategy (MANDATORY — see Risk 4)
Do NOT attempt a full 7000-company backfill on the first run.
1. Build and test all pipelines against seed data (20 companies)
2. Backfill Nifty 500 companies first (most-queried universe)
3. Expand to full BSE/NSE universe only after Nifty 500 is stable
4. Track per-company ingestion status so partial runs can resume

### Seed data
For initial development without hitting external APIs, create seed CSV files in `data/seeds/`:
- `companies_seed.csv` — 100 representative companies across sectors
- `financials_seed.csv` — 5 years of annual data for the 100 seed companies
- `prices_seed.csv` — 1 year of daily prices for the 100 seed companies
A `npm run seed` command loads these into the database.

---

## Phase 3: MCP tool implementation

### Tool registration pattern
Every tool follows this exact pattern:

```typescript
server.tool(
  'tool_name',
  'Clear description of what this tool does. Include: what data it returns, ' +
  'what parameters it accepts, and when an AI agent should use this tool vs alternatives. ' +
  'Example: search_companies("reliance") returns matching companies.',
  {
    // Zod schema for input parameters
    paramName: z.string().describe('What this parameter means and valid values'),
  },
  async ({ paramName }) => {
    // Validate and normalize inputs
    // Query database (via queries.ts functions)
    // Check cache first, populate on miss
    // Format response using response-builder
    // Return { content: [{ type: 'text', text: JSON.stringify(response) }] }
  }
);
```

### Tool descriptions must be excellent
AI agents discover tools via `listTools`. The description is ALL they have to decide whether to call your tool. Write descriptions that:
- Start with the action verb: "Search for...", "Calculate...", "Compare..."
- Include the return shape: "Returns an array of {company, metric, value} objects"
- Include when to use: "Use this when the user asks about a company's financial health"
- Include when NOT to use: "For price data, use get_price_history instead"
- Include an example call: "Example: get_income_statement({ ticker: 'RELIANCE', period: 'annual', years: 5 })"

### Tool description constraints (MANDATORY — see Risk 8)
- Every description MUST be under 200 words
- Follow the structure: action verb → returns → when to use → when NOT to use → example
- After all tools are built, test tool selection with multi-step agent queries
- If an agent picks the wrong tool, fix the description, not the tool logic

### Cowork session discipline for Phase 3 (MANDATORY — see Risk 2)
Phase 3 is the largest phase by code volume. To prevent pattern drift across sessions:
- Implement ONLY ONE tool domain per Cowork session
- Recommended session order: financials → valuation → screening → technicals → shareholding → corporate-actions → macro → portfolio → ai-native
- At the start of each Phase 3 session, Cowork MUST read `src/tools/company.ts` first as the reference
- After completing each domain, verify it matches the reference: try/catch wrapping, cache checks, buildResponse(), buildErrorResponse(), relatedTools populated, normalizeTicker() on all ticker inputs

### Screen parser routing (MANDATORY — see Risk 3)
The `run_screen` tool handles structured conditions ONLY. The `ask_about_data` tool handles natural language queries. Their descriptions MUST clearly distinguish when to use which. Do not try to make the screen parser handle fuzzy input — that's what ask_about_data is for.

### Domain-by-domain specifications

#### Company tools (src/tools/company.ts)

**search_companies**
- Input: `{ query: string, limit?: number (default 10), sector?: string, marketCapMin?: number, marketCapMax?: number }`
- Behavior: Fuzzy match on company name, exact match on ticker/ISIN. Filter by sector and market cap range if provided.
- Output: Array of `{ ticker, name, sector, industry, marketCap, exchange }`
- Performance: Must respond in <100ms. Use trigram index on company name.

**get_company_profile**
- Input: `{ ticker: string }`
- Behavior: Full company metadata. If ticker not found, suggest closest matches.
- Output: `{ ticker, name, isin, sector, industry, marketCap, listingDate, faceValue, exchange, website, registrar, latestPrice, dayChange, fiftyTwoWeekHigh, fiftyTwoWeekLow, pe, pb, dividendYield, bookValue }`

**get_company_peers**
- Input: `{ ticker: string, limit?: number (default 10) }`
- Behavior: Same industry companies ranked by market cap proximity.
- Output: Array of company profiles with key comparison metrics.

**get_index_constituents**
- Input: `{ index: string }` — e.g., "NIFTY 50", "NIFTY BANK", "NIFTY IT"
- Behavior: List all companies in the specified index with weights.
- Output: Array of `{ ticker, name, weight, sector }`

**get_sector_overview**
- Input: `{ sector: string }`
- Behavior: Aggregate stats for the sector.
- Output: `{ sector, companyCount, totalMarketCap, avgPE, avgPB, avgROE, topGainers: [...], topLosers: [...], largestCompanies: [...] }`

#### Financial tools (src/tools/financials.ts)

**get_income_statement**
- Input: `{ ticker: string, period: 'annual' | 'quarterly', years?: number (default 5) }`
- Output: Time series of P&L line items. Each period includes: revenue, expenses, operatingProfit, otherIncome, pbt, tax, netProfit, eps. Include YoY growth percentages.

**get_balance_sheet**
- Input: `{ ticker: string, period: 'annual' | 'quarterly', years?: number (default 5) }`
- Output: Time series of: equity, reserves, borrowings, otherLiabilities, fixedAssets, investments, otherAssets, totalAssets.

**get_cash_flow**
- Input: `{ ticker: string, period: 'annual' | 'quarterly', years?: number (default 5) }`
- Output: Time series of: operatingCashFlow, investingCashFlow, financingCashFlow, netCashFlow, freeCashFlow (computed: OCF - capex).

**get_financial_ratios**
- Input: `{ ticker: string, years?: number (default 10) }`
- Output: Time series of all computed ratios: pe, pb, roe, roce, debtToEquity, currentRatio, dividendYield, operatingMargin, netMargin, assetTurnover, interestCoverage, earningsYield, fcfYield.

**get_quarterly_results**
- Input: `{ ticker: string, quarters?: number (default 8) }`
- Output: Last N quarterly results with YoY and QoQ growth for revenue, profit, margins. Flag significant changes (>20% deviation from trend).

**compare_financials**
- Input: `{ tickers: string[] (max 5), metrics: string[], period: 'annual' | 'quarterly', years?: number }`
- Output: Side-by-side comparison matrix. Rows are metrics, columns are companies. Include sector averages for context.

#### Valuation tools (src/tools/valuation.ts)

**calculate_dcf**
- Input: `{ ticker: string, growthRate?: number, discountRate?: number, terminalGrowthRate?: number, projectionYears?: number (default 10) }`
- Behavior: If rates not provided, use sensible defaults based on sector and historical growth. Use last 3 years average FCF as base.
- Output: `{ intrinsicValue, currentPrice, upside, assumptions: {...}, sensitivityTable: [...] }`
- Sensitivity table: 5x5 grid varying growth rate and discount rate.
- **MANDATORY (see Risk 7):** Always return the sensitivity table. Always include in context: `"disclaimer": "This is a mechanical calculation based on historical data and assumed growth rates. It is not investment advice."` All valuation tool descriptions MUST include: "Results are illustrative calculations, not investment recommendations."

**get_valuation_metrics**
- Input: `{ ticker: string }`
- Output: Current valuation vs sector median vs market median: pe, forwardPe, pb, evEbitda, peg, priceToSales, priceToFcf, earningsYield, dividendYield.

**calculate_intrinsic_value**
- Input: `{ ticker: string, method: 'graham' | 'epv' | 'asset_based' | 'all' }`
- Output: Intrinsic value by selected method(s) with calculation breakdown.

**get_historical_valuations**
- Input: `{ ticker: string, years?: number (default 10) }`
- Output: Time series of PE, PB with min/max/median bands. Current position relative to historical range.

**valuation_screener**
- Input: `{ criteria: { metric: string, operator: 'gt' | 'lt' | 'between', value: number | [number, number] }[], limit?: number }`
- Output: Companies matching all criteria, sorted by composite score.

#### Screening tools (src/tools/screening.ts)

**run_screen**
- Input: `{ conditions: string, sortBy?: string, sortOrder?: 'asc' | 'desc', limit?: number (default 50) }`
- `conditions` is a natural-language-style query string: "ROCE > 20 AND Debt to equity < 0.5 AND Sales growth 5Years > 15 AND Market cap > 5000"
- Behavior: Parse conditions into parameterized SQL WHERE clauses. Support operators: >, <, >=, <=, =, BETWEEN. Support fields: any column in the ratios or companies tables.
- Output: Array of matching companies with the screened metrics highlighted.
- THIS IS THE MOST IMPORTANT TOOL. Make the parser robust. Support aliases (e.g., "PE" = "pe_ratio", "market cap" = "market_cap_cr", "ROE" = "return_on_equity").

**get_preset_screens**
- Input: `{ screen: 'magic_formula' | 'piotroski_f9' | 'graham_net_net' | 'coffee_can' | 'consistent_compounders' | 'high_dividend' | 'momentum' | 'low_pe_growth' | 'debt_free' | 'capacity_expansion' }`
- Behavior: Each preset is a hardcoded set of conditions run through `run_screen`.
- Output: Same as run_screen.

**Preset definitions:**
- `magic_formula`: Rank by (earnings yield + ROIC), top 30
- `piotroski_f9`: Piotroski score = 9 (all 9 criteria met)
- `graham_net_net`: Current assets - total liabilities > market cap (extreme value)
- `coffee_can`: ROCE > 15% for each of the last 10 years AND revenue growth > 10% each year
- `consistent_compounders`: PAT CAGR 10Y > 15% AND ROE > 15% AND debt/equity < 1
- `high_dividend`: Dividend yield > 3% AND payout ratio < 60% AND profit growth > 0
- `momentum`: Price > 200-day MA AND RSI between 50-70 AND volume surge > 2x
- `low_pe_growth`: PE < 15 AND earnings growth 3Y > 20%
- `debt_free`: Total borrowings = 0 AND market cap > 500cr
- `capacity_expansion`: Fixed assets doubled in 3 years OR CWIP > 30% of fixed assets

**save_custom_screen**
- Input: `{ name: string, conditions: string, description?: string }`
- Behavior: Persist to a `custom_screens` table. Retrieve later by name.

**backtest_screen**
- Input: `{ conditions: string, startDate: string, endDate: string, rebalanceFrequency: 'quarterly' | 'annually' }`
- Behavior: Run the screen at each rebalance date using historical data. Calculate portfolio returns assuming equal-weight allocation. Compare against Nifty 50 benchmark.
- Output: `{ totalReturn, cagr, maxDrawdown, sharpeRatio, benchmarkReturn, benchmarkCagr, periodReturns: [...] }`

#### Technical analysis tools (src/tools/technicals.ts)

**get_price_history**
- Input: `{ ticker: string, period: '1m' | '3m' | '6m' | '1y' | '3y' | '5y' | '10y' | 'max', interval?: 'daily' | 'weekly' | 'monthly' }`
- Output: OHLCV array with derived fields: returns, cumulative returns, volatility.

**calculate_moving_averages**
- Input: `{ ticker: string, periods: number[] (default [20, 50, 200]), type: 'sma' | 'ema' }`
- Output: Current MA values, crossover signals (golden cross, death cross), price position relative to each MA.

**calculate_rsi**
- Input: `{ ticker: string, period?: number (default 14) }`
- Output: `{ currentRSI, signal: 'oversold' | 'neutral' | 'overbought', history: [...last30days] }`

**calculate_macd**
- Input: `{ ticker: string, fastPeriod?: number (12), slowPeriod?: number (26), signalPeriod?: number (9) }`
- Output: `{ macdLine, signalLine, histogram, signal: 'bullish_crossover' | 'bearish_crossover' | 'neutral' }`

**get_technical_summary**
- Input: `{ ticker: string }`
- Output: Combined: MAs, RSI, MACD, Bollinger Bands position, volume trend, support/resistance levels, overall signal strength (strong buy to strong sell).

#### Shareholding tools (src/tools/shareholding.ts)

**get_shareholding_pattern**
- Input: `{ ticker: string, quarters?: number (default 8) }`
- Output: Time series of: promoter%, fii%, dii%, public%, pledged%.

**get_shareholding_changes**
- Input: `{ minChange?: number (default 1), type?: 'promoter' | 'fii' | 'dii' | 'all' }`
- Output: Companies with significant holding changes in the latest quarter.

**get_insider_trades**
- Input: `{ ticker?: string, days?: number (default 30), transactionType?: 'buy' | 'sell' | 'all' }`
- Output: Array of insider transactions. If no ticker, show market-wide.

**get_bulk_block_deals**
- Input: `{ days?: number (default 7) }`
- Output: Recent bulk and block deals with buyer/seller, quantity, price.

#### Corporate actions tools (src/tools/corporate-actions.ts)

**get_dividends**
- Input: `{ ticker: string, years?: number (default 10) }`
- Output: Dividend history with yield at each ex-date, CAGR of dividends.

**get_stock_splits_bonuses**
- Input: `{ ticker: string }`
- Output: All historical splits and bonuses with adjusted factor.

**get_upcoming_events**
- Input: `{ ticker?: string, days?: number (default 30), eventType?: 'results' | 'agm' | 'board_meeting' | 'all' }`
- Output: Calendar of upcoming corporate events. Market-wide if no ticker.

#### Macro tools (src/tools/macro.ts)

**get_market_overview**
- Input: `{}` (no params)
- Output: `{ nifty50, sensex, bankNifty, niftyIT, advanceDecline, fiiNetBuy, diiNetBuy, vix, topGainers: [...5], topLosers: [...5] }`

**get_macro_indicators**
- Input: `{ months?: number (default 24) }`
- Output: Time series of: repoRate, cpi, gdpGrowth, iip, pmi, usdInr.

**get_fii_dii_flows**
- Input: `{ days?: number (default 30) }`
- Output: Daily FII/DII buy, sell, net values. Cumulative totals.

**get_sector_rotation**
- Input: `{ period: '1w' | '1m' | '3m' }`
- Output: Sector-wise returns and flow direction, ranked by momentum.

#### Portfolio tools (src/tools/portfolio.ts)

**create_watchlist**
- Input: `{ name: string, tickers: string[] }`
- Behavior: Store in `watchlists` table. Per-session or per-API-key.

**analyze_portfolio**
- Input: `{ holdings: { ticker: string, quantity: number, avgPrice: number }[] }`
- Output: `{ totalValue, dayChange, sectorExposure: {...}, concentrationRisk, largestPosition, diversificationScore, beta, suggestedActions: [...] }`

**get_portfolio_returns**
- Input: `{ holdings: { ticker: string, quantity: number, buyDate: string, avgPrice: number }[], benchmarkIndex?: string }`
- Output: `{ xirr, absoluteReturn, benchmarkReturn, alpha, holdingPeriod, perStockReturns: [...] }`

**suggest_rebalancing**
- Input: `{ holdings: { ticker: string, quantity: number, avgPrice: number }[], targetSectorWeights?: Record<string, number> }`
- Output: Suggested trades to improve diversification and reduce concentration risk.

#### AI-native tools (src/tools/ai-native.ts)

**explain_company**
- Input: `{ ticker: string }`
- Output: A structured narrative optimized for LLM consumption:
  ```json
  {
    "overview": "What the company does in 2-3 sentences",
    "businessModel": "How it makes money",
    "competitivePosition": "Moat analysis",
    "financialHealth": { "strengths": [...], "concerns": [...] },
    "recentDevelopments": "Last 2 quarters highlights",
    "keyMetrics": { "revenue": ..., "profit": ..., "roe": ..., "debtToEquity": ... },
    "investmentConsiderations": { "bull": [...], "bear": [...] }
  }
  ```

**compare_investment_thesis**
- Input: `{ tickers: string[] (2-5) }`
- Output: Structured comparison across: business model, growth trajectory, profitability, valuation, risk factors. Clear winner/loser callouts per dimension.

**generate_research_report**
- Input: `{ ticker: string, depth: 'brief' | 'standard' | 'deep' }`
- Output: Structured research template with all sections populated from data.

**ask_about_data**
- Input: `{ question: string }`
- Behavior: Natural language question → SQL → execute → format response.
- Use a mapping of common phrases to SQL constructs. Support questions like:
  - "Which IT companies have ROE above 20%?"
  - "What is the average PE of Nifty 50 companies?"
  - "Top 10 companies by revenue growth in the last 3 years"
  - "How many companies have zero debt?"
- Output: Formatted answer with the underlying data table.

---

## Phase 4: Middleware and security

### Authentication (src/middleware/auth.ts)
- Bearer token validation: `Authorization: Bearer <api-key>`
- API keys stored in environment variable `EQUITY_MCP_API_KEYS` (comma-separated)
- Optional: no auth in development mode (`NODE_ENV=development`)
- Return 401 with clear error message on invalid/missing key

### Rate limiting (src/middleware/rate-limit.ts)
- Per-client (by API key): 100 requests/minute, 5000/day
- Sliding window algorithm using Redis
- Return 429 with `Retry-After` header
- Exempt health check endpoint

### Logging (src/middleware/logger.ts)
- Every tool call logged: `{ timestamp, clientId, tool, params, durationMs, status, error? }`
- Structured JSON format to stdout (for Docker log aggregation)
- Request ID propagated through the entire call chain

### Input validation
- Already handled by Zod schemas on each tool
- Additional: ticker normalization (uppercase, trim, handle `.NS`/`.BO` suffixes)
- SQL injection prevention: parameterized queries only (enforced by queries.ts pattern)

### Health check
- `GET /health` returns `{ status: 'healthy', db: 'connected', cache: 'connected', uptime: ..., toolCount: ..., companyCount: ... }`

---

## Phase 5: Transport and deployment

### Transport configuration (src/index.ts)
```
if (process.env.TRANSPORT === 'stdio') {
  // StdioServerTransport for Claude Desktop local dev
} else {
  // StreamableHTTPServerTransport on port 3000
  // SSE fallback on /sse endpoint
}
```

### Docker setup
- `Dockerfile`: Multi-stage build. Stage 1: `npm ci && npm run build`. Stage 2: slim Node.js image with only `build/` and `node_modules/`.
- `docker-compose.yml`: Three services: `server`, `postgres` (with persistent volume), `redis`.
- `.env.example`: All required environment variables documented.

### Session management caveat (see Risk 5)
The Streamable HTTP transport stores sessions in an in-memory `Map`. This is fine for single-instance deployments. If the server restarts, clients reconnect automatically. Document this in DEPLOYMENT.md. Only move to Redis-backed sessions or sticky-session load balancing if horizontal scaling becomes necessary.

### Redis failure handling (see Risk 6)
If Redis goes down, the server continues operating with degraded performance (all requests hit Postgres directly). The health endpoint already reports cache status. Ensure Postgres indexes are solid enough to handle uncached screening queries in <500ms. After deployment, monitor for slow queries and add composite indexes via new migration files as needed.

### Deployment targets (pick one)
**Railway (simplest):**
- `railway.toml` with build and deploy config
- Postgres and Redis as Railway services
- Auto-deploy on git push

**Fly.io:**
- `fly.toml` with machine config
- Fly Postgres and Upstash Redis
- Global edge deployment possible

**AWS (most control):**
- ECS Fargate task definition
- RDS Postgres + ElastiCache Redis
- ALB for HTTPS termination

### Client configuration examples

**Claude Desktop (claude_desktop_config.json):**
```json
{
  "mcpServers": {
    "equity-mcp": {
      "url": "https://your-deployment-url.com/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

**Cursor / VS Code (.vscode/mcp.json):**
```json
{
  "equity-mcp": {
    "type": "streamableHttp",
    "url": "https://your-deployment-url.com/mcp",
    "headers": {
      "Authorization": "Bearer your-api-key"
    }
  }
}
```

---

## Phase 6: MCP resources and prompts

### Resources
MCP resources are read-only data URIs that clients can list and read.

- `equity://company/{ticker}` — company profile
- `equity://financials/{ticker}/annual` — annual financial statements
- `equity://financials/{ticker}/quarterly` — quarterly results
- `equity://screen/{screenName}` — results of a preset screen
- `equity://market/overview` — current market snapshot
- `equity://macro/latest` — latest macro indicators

### Prompts
MCP prompts are reusable templates.

- `investment-analysis` — "Analyze {ticker} as a potential investment. Cover business model, financial health, valuation, and risks."
- `screen-builder` — "Help me build a stock screen. Ask me about my investment criteria step by step."
- `portfolio-review` — "Review this portfolio: {holdings}. Assess diversification, risk, and suggest improvements."
- `sector-deep-dive` — "Provide a deep analysis of the {sector} sector in India."

---

## Phase 7: Testing and documentation

### Unit tests (tests/unit/)
- `financial-math.test.ts` — CAGR, XIRR, DCF, Piotroski calculations
- `screen-parser.test.ts` — natural language condition parsing
- `nl-to-sql.test.ts` — question to SQL translation
- `response-builder.test.ts` — output formatting

### Integration tests (tests/integration/)
- `server.test.ts` — MCP handshake, listTools, callTool round-trip
- `tools.test.ts` — each tool called with valid and invalid inputs
- `auth.test.ts` — authenticated and unauthenticated requests
- `rate-limit.test.ts` — burst behavior, 429 responses

### Documentation (docs/)
- `TOOL_CATALOG.md` — every tool with description, inputs, outputs, examples
- `DEPLOYMENT.md` — step-by-step deployment guide for each platform
- `DATA_SOURCES.md` — where each data field comes from, update frequency
- `EXTENDING.md` — how to add new tool domains (the plugin guide)

---

## Future extensibility (post-MVP)

These can be added later as new plugin modules without touching existing code:

1. **ESG scores** — new table `esg_scores`, new tool file `src/tools/esg.ts`
2. **Management commentary analysis** — store annual report text, vector embeddings for semantic search
3. **News sentiment** — ingest from RSS feeds, compute sentiment scores
4. **Analyst estimates** — consensus estimates, earnings surprises
5. **Mutual fund holdings** — which funds hold which stocks, position changes
6. **Credit ratings** — CRISIL, ICRA, CARE ratings history
7. **Commodity prices** — for companies with commodity exposure
8. **Peer global comparison** — compare Indian companies with global peers
9. **Event-driven alerts** — MCP notifications when screens trigger
10. **Chart generation** — return SVG/PNG charts as MCP resources

Each requires only: (1) migration file, (2) ingestion script, (3) tool module file, (4) one import line in server.ts.

---

## Code style and conventions

- TypeScript strict mode, no `any`
- ESM imports (`import ... from '...'` with `.js` extensions in imports)
- Async/await everywhere, no raw promises
- Error handling: every tool wrapped in try/catch, returns structured error messages
- Naming: camelCase for variables/functions, PascalCase for types/interfaces, snake_case for DB columns and MCP tool names
- Files: kebab-case (`financial-math.ts`, not `financialMath.ts`)
- Max line length: 100 characters
- Use `const` by default, `let` only when reassignment needed

---

## Progress tracking

Create and maintain `PROGRESS.md` in the project root:

```markdown
# Build Progress

## Phase 1: Scaffold — COMPLETE
- [x] Package.json and dependencies
- [x] TypeScript config
- [x] Docker compose
- [x] Database schema
- [x] Connection management
- [x] Server entry point
- [x] Middleware stubs

## Phase 2: Data ingestion — NOT STARTED
- [ ] Company master list pipeline
- [ ] Financial statements pipeline
- [ ] Price history pipeline
- [ ] Shareholding pipeline
- [ ] Corporate actions pipeline
- [ ] Insider trades pipeline
- [ ] Macro indicators pipeline
- [ ] Seed data for development
- [ ] Cron scheduler

## Phase 3: Tools — NOT STARTED
- [ ] Company tools (5)
- [ ] Financial tools (6)
- [ ] Valuation tools (5)
- [ ] Screening tools (4)
- [ ] Technical tools (5)
- [ ] Shareholding tools (4)
- [ ] Corporate action tools (3)
- [ ] Macro tools (4)
- [ ] Portfolio tools (4)
- [ ] AI-native tools (4)

## Phase 4: Middleware — NOT STARTED
## Phase 5: Deployment — NOT STARTED
## Phase 6: Resources + Prompts — NOT STARTED
## Phase 7: Testing + Docs — NOT STARTED
```

Update this file as you complete each item. Read it at the start of every session.
