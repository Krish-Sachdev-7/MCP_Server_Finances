# EquityMCP Deployment Guide

## Prerequisites

You need the following installed before deploying EquityMCP:

- Node.js 20 or later
- Docker and Docker Compose (for local development)
- A Railway account or Fly.io account (for production deployment)
- PostgreSQL 16 and Redis 7 (provided by Docker locally, or by platform plugins in production)

## Local Development Setup

1. Clone the repository and install dependencies:

```bash
git clone <repo-url> && cd equity-mcp
npm install
```

2. Copy the environment template and adjust values if needed:

```bash
cp .env.example .env
```

3. Start PostgreSQL and Redis via Docker:

```bash
docker compose up -d
```

4. Run database migrations and seed data:

```bash
npm run db:migrate
npx tsx scripts/seed.ts
```

5. Start the server in HTTP mode (for testing with curl or MCP clients):

```bash
TRANSPORT=http npx tsx src/index.ts
```

6. Verify the health endpoint:

```bash
curl http://localhost:3000/health
```

You should see `{"status":"healthy","database":"connected","cache":"connected",...}`.

7. For stdio mode (Claude Desktop local), set `TRANSPORT=stdio` or omit it entirely, then configure your MCP client to launch the process directly.

## Railway Deployment

Railway provides the simplest deployment path with managed Postgres and Redis plugins.

1. Install the Railway CLI and log in:

```bash
npm i -g @railway/cli
railway login
```

2. Create a new project:

```bash
railway init
```

3. Add database plugins from the Railway dashboard: go to your project, click "New", and add both **PostgreSQL** and **Redis** plugins. Railway will automatically inject `DATABASE_URL` and `REDIS_URL` environment variables into your service.

4. Set required environment variables in the Railway dashboard or CLI:

```bash
railway variables set TRANSPORT=http
railway variables set NODE_ENV=production
railway variables set EQUITY_MCP_API_KEYS=your-secret-key-here
railway variables set ALLOWED_HOSTS=your-app.up.railway.app
```

5. Deploy:

```bash
railway up
```

6. Run migrations against the production database:

```bash
railway run npm run db:migrate
railway run npx tsx scripts/seed.ts
```

7. Verify the deployment at `https://your-app.up.railway.app/health`.

## Fly.io Deployment

Fly.io gives you more control over region placement. The default config uses `bom` (Mumbai) for lowest latency to Indian data sources.

1. Install the Fly CLI and log in:

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

2. Create the app and backing services:

```bash
fly apps create equity-mcp
fly postgres create --name equity-mcp-db --region bom
fly postgres attach equity-mcp-db
fly redis create --name equity-mcp-cache --region bom
```

3. Set secrets:

```bash
fly secrets set \
  EQUITY_MCP_API_KEYS=your-secret-key-here \
  TRANSPORT=http \
  NODE_ENV=production \
  ALLOWED_HOSTS=equity-mcp.fly.dev \
  REDIS_URL=<redis-url-from-fly-redis-create-output>
```

4. Deploy:

```bash
fly deploy
```

5. Run migrations:

```bash
fly ssh console -C "node build/index.js --migrate"
```

Or connect to the Fly Postgres instance directly and run migrations from your local machine:

```bash
fly proxy 15432:5432 -a equity-mcp-db &
DATABASE_URL=postgresql://postgres:password@localhost:15432/equity_mcp npm run db:migrate
```

6. Verify at `https://equity-mcp.fly.dev/health`.

## Environment Variables Reference

| Variable | Description | Default | Required |
|---|---|---|---|
| `TRANSPORT` | Transport mode: `http` for Streamable HTTP, `stdio` for local Claude Desktop | `stdio` | No |
| `PORT` | HTTP server port (only used with `TRANSPORT=http`) | `3000` | No |
| `DATABASE_URL` | PostgreSQL connection string | (none) | Yes |
| `REDIS_URL` | Redis connection string | (none) | No (degrades gracefully) |
| `EQUITY_MCP_API_KEYS` | Comma-separated list of valid API keys for bearer auth | (none) | Yes in production |
| `ALLOWED_HOSTS` | Comma-separated list of allowed Host header values for DNS rebinding protection | (permissive in dev, warns in prod) | Recommended in production |
| `RATE_LIMIT_RPM` | Maximum requests per minute per client | `100` | No |
| `RATE_LIMIT_RPD` | Maximum requests per day per client | `5000` | No |
| `LOG_LEVEL` | Pino log level: trace, debug, info, warn, error, fatal | `info` | No |
| `NODE_ENV` | Environment: `development` or `production` | `development` | No |

## Known Limitations

### In-memory session management

MCP sessions are stored in a JavaScript `Map` in the server process. This means sessions are lost on server restart, and they cannot be shared across multiple instances. Clients that use Streamable HTTP transport will need to reconnect after a restart, which MCP clients handle automatically.

For single-instance deployments (the default for both Railway and Fly.io configs), this is not an issue. If you need to scale to multiple instances, you would need to implement Redis-backed session storage or configure sticky load balancing so that each client always hits the same instance.

### Redis failure degrades but does not crash

If Redis becomes unavailable, the server continues to function. All queries go directly to PostgreSQL, which increases latency but maintains correctness. The `/health` endpoint will report `cache: "disconnected"` in this state. Monitor the health endpoint and set up alerts on cache disconnection for production deployments.

## Connecting MCP Clients

### Claude Desktop

Add this to your Claude Desktop MCP configuration file (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "equity-mcp": {
      "url": "https://your-app.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

For local stdio mode:

```json
{
  "mcpServers": {
    "equity-mcp": {
      "command": "node",
      "args": ["/path/to/equity-mcp/build/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://equitymcp:equitymcp_dev_password@localhost:5432/equitymcp",
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

### Cursor / VS Code

Add to your `.cursor/mcp.json` or VS Code MCP settings:

```json
{
  "mcpServers": {
    "equity-mcp": {
      "url": "https://your-app.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add equity-mcp --transport http https://your-app.up.railway.app/mcp \
  --header "Authorization: Bearer your-api-key"
```
