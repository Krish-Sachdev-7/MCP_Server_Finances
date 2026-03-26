# EquityMCP Tool Catalog

**44 tools across 10 domains.**

This catalog is generated from `server.tool(...)` registrations in `src/tools/*.ts`.
All tools return standardized JSON strings via `buildResponse(...)` with this shape:

```json
{
  "summary": "One-line summary",
  "data": { "...": "tool-specific payload" },
  "context": { "...": "metadata, units, period, freshness" },
  "relatedTools": ["other_tool_name"]
}
```

---

## Company (5)

### `search_companies`
- **Description:** Search listed Indian companies by ticker, name, or ISIN.
- **Inputs:**
  - `query: string` (required)
  - `limit?: number`
  - `sector?: string`
  - `marketCapMin?: number`
  - `marketCapMax?: number`
- **Returns:** matching companies with key identity fields and optional filter context.
- **Example usage:**
```json
{ "tool": "search_companies", "arguments": { "query": "bank", "limit": 10 } }
```

### `get_company_profile`
- **Description:** Get complete profile and latest core metrics for one company.
- **Inputs:**
  - `ticker: string` (required)
- **Returns:** company profile, latest price/date, and latest valuation/profitability snapshot.
- **Example usage:**
```json
{ "tool": "get_company_profile", "arguments": { "ticker": "HDFCBANK" } }
```

### `get_company_peers`
- **Description:** Find peers in same industry, ordered by market-cap proximity.
- **Inputs:**
  - `ticker: string` (required)
  - `limit?: number`
- **Returns:** base company info + peer list.
- **Example usage:**
```json
{ "tool": "get_company_peers", "arguments": { "ticker": "INFY", "limit": 8 } }
```

### `get_index_constituents`
- **Description:** List all constituents for a supported market index.
- **Inputs:**
  - `index: string` (required)
- **Returns:** constituent rows with weights (when available).
- **Example usage:**
```json
{ "tool": "get_index_constituents", "arguments": { "index": "NIFTY_50" } }
```

### `get_sector_overview`
- **Description:** Sector-level aggregate stats and top movers.
- **Inputs:**
  - `sector: string` (required)
- **Returns:** company count, aggregate valuation/profitability and top companies/gainers/losers.
- **Example usage:**
```json
{ "tool": "get_sector_overview", "arguments": { "sector": "BANKING" } }
```

---

## Financials (6)

### `get_income_statement`
- **Description:** Income statement time-series (annual or quarterly).
- **Inputs:**
  - `ticker: string` (required)
  - `period: "annual" | "quarterly"` (required)
  - `years?: number`
- **Returns:** period rows with revenue/profit components and growth fields.
- **Example usage:**
```json
{ "tool": "get_income_statement", "arguments": { "ticker": "TCS", "period": "annual", "years": 5 } }
```

### `get_balance_sheet`
- **Description:** Balance sheet history by period.
- **Inputs:**
  - `ticker: string` (required)
  - `period: "annual" | "quarterly"` (required)
  - `years?: number`
- **Returns:** assets/liabilities/equity structure over time.
- **Example usage:**
```json
{ "tool": "get_balance_sheet", "arguments": { "ticker": "RELIANCE", "period": "annual", "years": 5 } }
```

### `get_cash_flow`
- **Description:** Cash-flow history including computed free cash flow.
- **Inputs:**
  - `ticker: string` (required)
  - `period: "annual" | "quarterly"` (required)
  - `years?: number`
- **Returns:** OCF/investing/financing/net-cash and FCF series.
- **Example usage:**
```json
{ "tool": "get_cash_flow", "arguments": { "ticker": "INFY", "period": "annual", "years": 5 } }
```

### `get_financial_ratios`
- **Description:** Historical valuation, profitability, leverage, and efficiency ratios.
- **Inputs:**
  - `ticker: string` (required)
  - `years?: number`
- **Returns:** yearly ratio snapshots.
- **Example usage:**
```json
{ "tool": "get_financial_ratios", "arguments": { "ticker": "HINDUNILVR", "years": 10 } }
```

### `get_quarterly_results`
- **Description:** Recent quarterly performance with YoY/QoQ trends.
- **Inputs:**
  - `ticker: string` (required)
  - `quarters?: number`
- **Returns:** quarterly rows with growth and significant-change flags.
- **Example usage:**
```json
{ "tool": "get_quarterly_results", "arguments": { "ticker": "SBIN", "quarters": 8 } }
```

### `compare_financials`
- **Description:** Side-by-side metric matrix across up to 5 companies.
- **Inputs:**
  - `tickers: string[]` (required)
  - `metrics: string[]` (required)
  - `period: "annual" | "quarterly"` (required)
  - `years?: number`
- **Returns:** comparison matrix, company metadata, and sector context.
- **Example usage:**
```json
{
  "tool": "compare_financials",
  "arguments": {
    "tickers": ["HDFCBANK", "ICICIBANK"],
    "metrics": ["roe", "net_margin"],
    "period": "annual",
    "years": 5
  }
}
```

---

## Valuation (5)

### `calculate_dcf`
- **Description:** DCF valuation with assumptions and sensitivity table.
- **Inputs:**
  - `ticker: string` (required)
  - `growthRate?: number`
  - `discountRate?: number`
  - `terminalGrowthRate?: number`
  - `projectionYears?: number`
- **Returns:** DCF outputs, projected cash flows, and a mandatory 5x5 sensitivity table.
- **Example usage:**
```json
{ "tool": "calculate_dcf", "arguments": { "ticker": "TCS", "growthRate": 0.12, "discountRate": 0.14 } }
```

### `get_valuation_metrics`
- **Description:** Current and historical valuation multiple context.
- **Inputs:**
  - `ticker: string` (required)
  - `years?: number`
- **Returns:** current multiples + historical stats and percentile perspective.
- **Example usage:**
```json
{ "tool": "get_valuation_metrics", "arguments": { "ticker": "ASIANPAINT", "years": 10 } }
```

### `calculate_intrinsic_value`
- **Description:** Multi-method intrinsic value estimate (range-based).
- **Inputs:**
  - `ticker: string` (required)
  - `discountRate?: number`
- **Returns:** method-wise values, average/range, and margin diagnostics.
- **Example usage:**
```json
{ "tool": "calculate_intrinsic_value", "arguments": { "ticker": "ITC", "discountRate": 0.12 } }
```

### `get_historical_valuations`
- **Description:** Year-wise valuation trend and bands.
- **Inputs:**
  - `ticker: string` (required)
  - `years?: number`
- **Returns:** historical valuation series with min/max/avg/current context.
- **Example usage:**
```json
{ "tool": "get_historical_valuations", "arguments": { "ticker": "ULTRACEMCO", "years": 8 } }
```

### `valuation_screener`
- **Description:** Screen companies by valuation constraints.
- **Inputs:**
  - `peMin?: number`
  - `peMax?: number`
  - `pbMin?: number`
  - `pbMax?: number`
  - `evEbitdaMax?: number`
  - `dividendYieldMin?: number`
  - `earningsYieldMin?: number`
  - `fcfYieldMin?: number`
  - `sector?: string`
  - `sortBy?: "pe_ratio" | "pb_ratio" | "ev_ebitda" | "dividend_yield" | "earnings_yield" | "fcf_yield" | "market_cap_cr"`
  - `sortOrder?: "ASC" | "DESC"`
  - `limit?: number`
- **Returns:** screened list with valuation and selected quality fields.
- **Example usage:**
```json
{ "tool": "valuation_screener", "arguments": { "peMax": 20, "pbMax": 3, "sortBy": "pe_ratio", "sortOrder": "ASC", "limit": 50 } }
```

---

## Screening (4)

### `run_screen`
- **Description:** Execute explicit numeric screens using parser-friendly conditions.
- **Inputs:**
  - `conditions: string` (required)
  - `sortBy?: string`
  - `sortOrder?: "ASC" | "DESC"`
  - `limit?: number`
- **Returns:** matched companies and parsed-condition context.
- **Example usage:**
```json
{ "tool": "run_screen", "arguments": { "conditions": "ROE > 15 AND PE < 20", "sortBy": "market_cap", "sortOrder": "DESC", "limit": 25 } }
```

### `get_preset_screens`
- **Description:** List presets or execute one preset.
- **Inputs:**
  - `presetId?: string`
  - `limit?: number`
- **Returns:** preset list or `{ preset, results }` payload for selected preset.
- **Example usage:**
```json
{ "tool": "get_preset_screens", "arguments": { "presetId": "quality_compounding", "limit": 20 } }
```

### `save_custom_screen`
- **Description:** Save reusable custom screen definitions.
- **Inputs:**
  - `name: string` (required)
  - `conditions: string` (required)
  - `description?: string`
  - `clientId?: string`
- **Returns:** persisted screen metadata and parse diagnostics.
- **Example usage:**
```json
{ "tool": "save_custom_screen", "arguments": { "name": "Low Debt Compounders", "conditions": "ROE > 18 AND debt to equity < 0.5", "description": "Quality + balance sheet" } }
```

### `backtest_screen`
- **Description:** Historical backtest for a screening rule.
- **Inputs:**
  - `conditions: string` (required)
  - `years?: number`
  - `rebalanceFrequency?: "annual" | "semi-annual"`
  - `limit?: number`
- **Returns:** return series, cumulative curve, benchmark comparison, caveats.
- **Example usage:**
```json
{ "tool": "backtest_screen", "arguments": { "conditions": "ROCE > 20 AND PE < 25", "years": 5, "rebalanceFrequency": "annual" } }
```

---

## Technicals (5)

### `get_price_history`
- **Description:** OHLCV history by period and interval.
- **Inputs:**
  - `ticker: string` (required)
  - `period?: "1m" | "3m" | "6m" | "1y" | "2y" | "3y" | "5y" | "10y" | "max"`
  - `interval?: "daily" | "weekly" | "monthly"`
- **Returns:** normalized candle series and period statistics.
- **Example usage:**
```json
{ "tool": "get_price_history", "arguments": { "ticker": "INFY", "period": "1y", "interval": "daily" } }
```

### `calculate_moving_averages`
- **Description:** SMA/EMA indicators and crossover signals.
- **Inputs:**
  - `ticker: string` (required)
  - `periods?: number[]`
- **Returns:** MA values, crossover signal, and trend context.
- **Example usage:**
```json
{ "tool": "calculate_moving_averages", "arguments": { "ticker": "RELIANCE", "periods": [20, 50, 200] } }
```

### `calculate_rsi`
- **Description:** RSI value, status, and recent path.
- **Inputs:**
  - `ticker: string` (required)
  - `period?: number`
- **Returns:** latest RSI, classification (overbought/oversold/neutral), and history.
- **Example usage:**
```json
{ "tool": "calculate_rsi", "arguments": { "ticker": "SBIN", "period": 14 } }
```

### `calculate_macd`
- **Description:** MACD oscillator, signal line, histogram, and crossover trend.
- **Inputs:**
  - `ticker: string` (required)
  - `fastPeriod?: number`
  - `slowPeriod?: number`
  - `signalPeriod?: number`
- **Returns:** current and recent MACD analytics with trend flags.
- **Example usage:**
```json
{ "tool": "calculate_macd", "arguments": { "ticker": "TCS", "fastPeriod": 12, "slowPeriod": 26, "signalPeriod": 9 } }
```

### `get_technical_summary`
- **Description:** Consolidated technical snapshot across indicators.
- **Inputs:**
  - `ticker: string` (required)
- **Returns:** combined MA/RSI/MACD/Bollinger/volume/support-resistance summary + overall signal.
- **Example usage:**
```json
{ "tool": "get_technical_summary", "arguments": { "ticker": "HDFCBANK" } }
```

---

## Shareholding (4)

### `get_shareholding_pattern`
- **Description:** Quarterly ownership composition by holder class.
- **Inputs:**
  - `ticker: string` (required)
  - `quarters?: number`
- **Returns:** quarter-wise promoter/FII/DII/public/pledged series.
- **Example usage:**
```json
{ "tool": "get_shareholding_pattern", "arguments": { "ticker": "ITC", "quarters": 8 } }
```

### `get_shareholding_changes`
- **Description:** Quarter-over-quarter ownership deltas.
- **Inputs:**
  - `ticker: string` (required)
  - `quarters?: number`
- **Returns:** change vectors and significant movement markers.
- **Example usage:**
```json
{ "tool": "get_shareholding_changes", "arguments": { "ticker": "RELIANCE", "quarters": 4 } }
```

### `get_insider_trades`
- **Description:** Insider buy/sell disclosures for a company or market-wide.
- **Inputs:**
  - `ticker?: string`
  - `days?: number`
  - `transactionType?: "buy" | "sell" | "all"`
- **Returns:** trade list plus aggregate buy/sell counts.
- **Example usage:**
```json
{ "tool": "get_insider_trades", "arguments": { "ticker": "INFY", "days": 90, "transactionType": "all" } }
```

### `get_bulk_block_deals`
- **Description:** Bulk/block deals with value filters.
- **Inputs:**
  - `ticker?: string`
  - `days?: number`
  - `minValueCr?: number`
- **Returns:** deal rows with totals and applied filter metadata.
- **Example usage:**
```json
{ "tool": "get_bulk_block_deals", "arguments": { "days": 30, "minValueCr": 25 } }
```

---

## Corporate Actions (3)

### `get_dividends`
- **Description:** Dividend history and payout summary.
- **Inputs:**
  - `ticker: string` (required)
- **Returns:** dividend events plus totals/averages and coverage metadata.
- **Example usage:**
```json
{ "tool": "get_dividends", "arguments": { "ticker": "TCS" } }
```

### `get_stock_splits_bonuses`
- **Description:** Capital actions (split/bonus/rights) history.
- **Inputs:**
  - `ticker: string` (required)
- **Returns:** event timeline with per-type counts.
- **Example usage:**
```json
{ "tool": "get_stock_splits_bonuses", "arguments": { "ticker": "INFY" } }
```

### `get_upcoming_events`
- **Description:** Upcoming market-wide corporate event calendar.
- **Inputs:**
  - `days?: number`
  - `actionType?: "dividend" | "split" | "bonus" | "rights" | "buyback"`
- **Returns:** upcoming events with action-type breakdown.
- **Example usage:**
```json
{ "tool": "get_upcoming_events", "arguments": { "days": 30, "actionType": "dividend" } }
```

---

## Macro (4)

### `get_market_overview`
- **Description:** Broad market snapshot across indices, breadth, and flows.
- **Inputs:** none
- **Returns:** market-level composite payload (indices, breadth, flows, movers, VIX placeholder).
- **Example usage:**
```json
{ "tool": "get_market_overview", "arguments": {} }
```

### `get_macro_indicators`
- **Description:** Time-series macro indicators.
- **Inputs:**
  - `months?: number`
- **Returns:** indicator series with count/freshness context.
- **Example usage:**
```json
{ "tool": "get_macro_indicators", "arguments": { "months": 24 } }
```

### `get_fii_dii_flows`
- **Description:** Daily FII/DII net flow history.
- **Inputs:**
  - `days?: number`
- **Returns:** daily rows + cumulative totals + directional trend.
- **Example usage:**
```json
{ "tool": "get_fii_dii_flows", "arguments": { "days": 60 } }
```

### `get_sector_rotation`
- **Description:** Sector return ranking over a selected horizon.
- **Inputs:**
  - `period: "1w" | "1m" | "3m"` (required)
- **Returns:** ranked sectors with performance dispersion and signal tags.
- **Example usage:**
```json
{ "tool": "get_sector_rotation", "arguments": { "period": "1m" } }
```

---

## Portfolio (4)

### `create_watchlist`
- **Description:** Create/update named watchlists.
- **Inputs:**
  - `name: string` (required)
  - `tickers: string[]` (required)
- **Returns:** saved watchlist name, normalized tickers, and count.
- **Example usage:**
```json
{ "tool": "create_watchlist", "arguments": { "name": "Core", "tickers": ["RELIANCE", "TCS", "HDFCBANK"] } }
```

### `analyze_portfolio`
- **Description:** Portfolio valuation, exposures, and risk diagnostics.
- **Inputs:**
  - `holdings: Array<{ ticker: string; quantity: number; avgPrice: number }>` (required)
- **Returns:** totals, P/L, exposure map, concentration stats, warnings, holding-level details.
- **Example usage:**
```json
{
  "tool": "analyze_portfolio",
  "arguments": {
    "holdings": [
      { "ticker": "TCS", "quantity": 10, "avgPrice": 3200 },
      { "ticker": "INFY", "quantity": 15, "avgPrice": 1450 }
    ]
  }
}
```

### `get_portfolio_returns`
- **Description:** Compute XIRR and benchmark-relative return analytics.
- **Inputs:**
  - `holdings: Array<{ ticker: string; quantity: number; buyDate: string; avgPrice: number }>` (required)
  - `benchmarkIndex?: string`
- **Returns:** XIRR, absolute return, alpha vs benchmark, per-stock CAGR, warnings.
- **Example usage:**
```json
{
  "tool": "get_portfolio_returns",
  "arguments": {
    "holdings": [
      { "ticker": "HDFCBANK", "quantity": 20, "buyDate": "2022-01-10", "avgPrice": 1500 }
    ],
    "benchmarkIndex": "NIFTY_50"
  }
}
```

### `suggest_rebalancing`
- **Description:** Rules-based rebalancing recommendations.
- **Inputs:**
  - `holdings: Array<{ ticker: string; quantity: number; avgPrice: number }>` (required)
  - `targetSectorWeights?: Record<string, number>`
- **Returns:** prioritized action suggestions and portfolio-health diagnostics.
- **Example usage:**
```json
{ "tool": "suggest_rebalancing", "arguments": { "holdings": [{ "ticker": "RELIANCE", "quantity": 30, "avgPrice": 2400 }] } }
```

---

## AI-Native (4)

### `ask_about_data`
- **Description:** Natural-language question answering over structured equity data.
- **Inputs:**
  - `question: string` (required)
- **Returns:** interpreted query metadata + raw row results + row count.
- **Example usage:**
```json
{ "tool": "ask_about_data", "arguments": { "question": "Which large-cap IT companies have ROE above 20%?" } }
```

### `explain_company`
- **Description:** Structured company narrative across business/financial dimensions.
- **Inputs:**
  - `ticker: string` (required)
- **Returns:** multi-section explanation with health indicators and freshness notes.
- **Example usage:**
```json
{ "tool": "explain_company", "arguments": { "ticker": "LT" } }
```

### `compare_investment_thesis`
- **Description:** Multi-company thesis comparison across 8 dimensions.
- **Inputs:**
  - `tickers: string[]` (required)
- **Returns:** comparison matrix, leaders by dimension, and caveats.
- **Example usage:**
```json
{ "tool": "compare_investment_thesis", "arguments": { "tickers": ["HDFCBANK", "ICICIBANK", "KOTAKBANK"] } }
```

### `generate_research_report`
- **Description:** Depth-controlled research report (brief/standard/deep).
- **Inputs:**
  - `ticker: string` (required)
  - `depth: "brief" | "standard" | "deep"` (required)
- **Returns:** structured report sections, assumptions/disclaimer context, and data references.
- **Example usage:**
```json
{ "tool": "generate_research_report", "arguments": { "ticker": "SUNPHARMA", "depth": "standard" } }
```

---

## Quick totals

| Domain | Tools |
|---|---:|
| Company | 5 |
| Financials | 6 |
| Valuation | 5 |
| Screening | 4 |
| Technicals | 5 |
| Shareholding | 4 |
| Corporate Actions | 3 |
| Macro | 4 |
| Portfolio | 4 |
| AI-Native | 4 |
| **Total** | **44** |
