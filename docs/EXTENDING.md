# Extending EquityMCP with New Tool Domains

This guide explains how to add a new domain plugin end-to-end while preserving the existing plugin-first architecture.

## 1) Create a migration file

Create a new numbered SQL file under `src/db/migrations/`.

Example:
- `002_add_esg_tables.sql`

Rules:
- Never edit old migrations.
- Use additive changes only.
- Include indexes needed for expected filters/sorts.

Minimal pattern:

```sql
CREATE TABLE IF NOT EXISTS esg_scores (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_end_date DATE NOT NULL,
  esg_score NUMERIC,
  environment_score NUMERIC,
  social_score NUMERIC,
  governance_score NUMERIC,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, period_end_date)
);

CREATE INDEX IF NOT EXISTS idx_esg_scores_company_date
  ON esg_scores(company_id, period_end_date DESC);
```

## 2) Add query functions in `src/db/queries.ts`

Create parameterized helper functions only.

Checklist:
- No string-concatenated SQL.
- Return typed rows.
- Keep business logic in tools, not query text.

Example shape:

```ts
export async function getLatestEsgByTicker(db: Pool, ticker: string) {
  const sql = `
    SELECT c.ticker, c.company_name, e.*
    FROM companies c
    JOIN esg_scores e ON e.company_id = c.id
    WHERE c.ticker = $1
    ORDER BY e.period_end_date DESC
    LIMIT 1
  `;
  const result = await db.query(sql, [ticker]);
  return result.rows[0] ?? null;
}
```

## 3) Create `src/tools/your-domain.ts`

Export exactly one function:

```ts
export function registerTools(server: McpServer, db: Pool, cache: RedisClient): void
```

Follow existing domain style:
- Validate all input with Zod.
- Normalize ticker inputs.
- Cache before DB read.
- Return `buildResponse` for success and `buildErrorResponse` for failures.

## 4) Register in `src/server.ts`

Add import + registration call:

```ts
import { registerTools as registerYourDomain } from './tools/your-domain.js';
registerYourDomain(server, db, cache);
```

## 5) Optionally add ingestion pipeline

If your domain needs external data:
- Add `src/ingestion/your-domain.ts` with `name`, `schedule`, `run(...)` exports.
- Add it to the pipeline loader list in `src/ingestion/runner.ts`.
- Implement primary + fallback source chain when feasible.

## 6) Minimal tool registration pattern (based on `company.ts` style)

```ts
import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedisClient } from '../cache/redis.js';
import { TTL, cacheGet, cacheKey, cacheSet } from '../cache/redis.js';
import { buildErrorResponse, buildResponse, normalizeTicker } from '../utils/response-builder.js';
import { getCompanyByTicker } from '../db/queries.js';

export function registerTools(server: McpServer, db: Pool, cache: RedisClient): void {
  server.tool(
    'get_example_metric',
    'Get a cached metric for one company.',
    {
      ticker: z.string().min(1),
      lookbackYears: z.number().int().min(1).max(20).optional(),
    },
    async ({ ticker, lookbackYears = 5 }) => {
      try {
        const symbol = normalizeTicker(ticker);
        const key = cacheKey('example_metric', symbol, { lookbackYears });

        const cached = await cacheGet<unknown>(key);
        if (cached) {
          return buildResponse({
            summary: `Loaded cached metric for ${symbol}`,
            data: cached,
            context: { ticker: symbol, source: 'cache' },
            relatedTools: ['get_company_profile'],
          });
        }

        const company = await getCompanyByTicker(db, symbol);
        if (!company) {
          return buildErrorResponse('get_example_metric', `Company not found: ${symbol}`, 'Try a valid NSE/BSE ticker.');
        }

        const data = {
          ticker: symbol,
          lookbackYears,
          metricValue: 0,
        };

        await cacheSet(key, data, TTL.FINANCIAL_DATA);

        return buildResponse({
          summary: `Computed example metric for ${symbol}`,
          data,
          context: { ticker: symbol, lookbackYears, source: 'database' },
          relatedTools: ['get_company_profile', 'get_financial_ratios'],
        });
      } catch (error) {
        return buildErrorResponse(
          'get_example_metric',
          error instanceof Error ? error.message : String(error),
          'Retry with valid parameters or reduce lookbackYears.'
        );
      }
    }
  );
}
```

## 7) Candidate future domains (from project spec)

Planned/high-value additions:
- ESG scores
- News sentiment
- Analyst estimates
- Mutual fund holdings
- Credit ratings
- Commodity prices
- Global peer comparison
- Event alerts
- Charts

## Implementation checklist

- Migration created and applied.
- Query functions added with parameterized SQL.
- New tool file exports `registerTools`.
- Tools use Zod, cache helpers, and response builders.
- Plugin imported and registered in `src/server.ts`.
- Optional ingestion pipeline wired in runner.
- Unit tests added under `tests/unit`.
- Tool descriptions concise and agent-oriented.
