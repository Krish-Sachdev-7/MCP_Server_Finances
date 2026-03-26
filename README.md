# EquityMCP

MCP server for Indian equity market data — ~7000 listed companies accessible to AI agents.

## What is this?

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI agents like Claude, Cursor, and custom agents access to comprehensive Indian stock market data: financial statements, valuation metrics, screening tools, technical analysis, and more.

Think **screener.in as an API for AI agents**.

## Quick start

```bash
# 1. Start database and cache
docker compose up -d postgres redis

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env

# 4. Run migrations
npm run db:migrate

# 5. Seed sample data (20 companies, 5 years)
npx tsx scripts/seed.ts

# 6. Start the server (Streamable HTTP on port 3000)
TRANSPORT=http npx tsx src/index.ts
```

## Connect from Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "equity-mcp": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer dev-key-12345"
      }
    }
  }
}
```

## Tool domains

**Total: 44 tools across 10 domains.**

| Domain | Tools | Description |
|--------|-------|-------------|
| Company | 5 | Search, profiles, peers, index constituents, sector overview |
| Financials | 6 | P&L, balance sheet, cash flow, ratios, quarterly results, compare |
| Valuation | 5 | DCF, multiples, intrinsic value, historical valuations, screener |
| Screening | 4 | Custom screens, preset screens, save screens, backtest |
| Technicals | 5 | Price history, moving averages, RSI, MACD, technical summary |
| Shareholding | 4 | Patterns, changes, insider trades, bulk/block deals |
| Corporate Actions | 3 | Dividends, splits/bonuses, upcoming events |
| Macro | 4 | Market overview, indicators, FII/DII flows, sector rotation |
| Portfolio | 4 | Watchlists, portfolio analysis, returns, rebalancing |
| AI-native | 4 | Explain company, compare thesis, research report, NL query |
| **Total** | **44** | **All registered MCP tools** |

## Documentation

- [Tool catalog](docs/TOOL_CATALOG.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Extending guide](docs/EXTENDING.md)
- [Data sources](docs/DATA_SOURCES.md)

## Testing

- Run all tests with `npm test` (alias for `vitest run`).
- Current unit coverage includes:
  - Financial math utilities (`cagr`, `xirr`, `dcfValuation`, `piotroskiScore`, `grahamNumber`, `sma`, `ema`, `rsi`, `macd`)
  - Screen parser utilities (`parseScreenConditions`, sort validators)
  - Response builder utilities (`buildResponse`, formatting and normalization helpers)
  - Cache utilities (`cacheKey` behavior and TTL constants)

## Architecture

See `SKILL.md` for the full specification and `PROGRESS.md` for build status.

## License

MIT
