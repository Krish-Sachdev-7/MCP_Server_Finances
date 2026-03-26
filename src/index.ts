import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { createServer } from './server.js';
import { getPool, closePool, checkDbHealth } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { getRedis, connectRedis, closeRedis, checkCacheHealth } from './cache/redis.js';
import { validateApiKey } from './middleware/auth.js';
import { checkRateLimit } from './middleware/rate-limit.js';
import { validateHost } from './middleware/host-validation.js';
import { rootLogger } from './middleware/logger.js';

const logger = rootLogger.child({ module: 'main' });

async function main(): Promise<void> {
  const transport = process.env.TRANSPORT || 'stdio';
  const port = parseInt(process.env.PORT || '3000', 10);

  // Initialize database
  logger.info('Running database migrations...');
  await runMigrations();

  // Connect Redis
  logger.info('Connecting to Redis...');
  try {
    await connectRedis();
  } catch (err) {
    logger.warn({ err }, 'Redis connection failed — running without cache');
  }

  const db = getPool();
  const cache = getRedis();

  // Create MCP server
  const mcpServer = await createServer(db, cache);

  if (transport === 'stdio') {
    // ============================================================
    // STDIO TRANSPORT (for Claude Desktop local development)
    // ============================================================
    logger.info('Starting in stdio mode');
    const stdioTransport = new StdioServerTransport();
    await mcpServer.connect(stdioTransport);
    logger.info('MCP server connected via stdio');
  } else {
    // ============================================================
    // HTTP TRANSPORT (for remote deployment)
    // ============================================================
    const app = express();

    // Health check endpoint (no auth required)
    app.get('/health', async (_req, res) => {
      const dbOk = await checkDbHealth();
      const cacheOk = await checkCacheHealth();
      const status = dbOk ? 'healthy' : 'degraded';

      res.status(dbOk ? 200 : 503).json({
        status,
        database: dbOk ? 'connected' : 'disconnected',
        cache: cacheOk ? 'connected' : 'disconnected',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    // Host header validation for DNS rebinding protection
    app.use('/mcp', validateHost);

    // MCP endpoint with Streamable HTTP transport
    // Sessions map for managing transport instances
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    app.post('/mcp', express.json(), async (req, res) => {
      // Authentication
      const auth = validateApiKey(req.headers.authorization);
      if (!auth.valid) {
        res.status(401).json({ error: auth.error });
        return;
      }

      // Rate limiting
      const rateResult = await checkRateLimit(auth.clientId || 'unknown');
      if (!rateResult.allowed) {
        res.status(429)
          .header('Retry-After', String(rateResult.resetInSeconds))
          .json({
            error: 'Rate limit exceeded',
            limit: rateResult.limit,
            retryAfter: rateResult.resetInSeconds,
          });
        return;
      }

      // Get or create session transport
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
      } else {
        // New session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
            logger.info({ sessionId: id, clientId: auth.clientId }, 'MCP session created');
          },
        });

        transport.onclose = () => {
          const id = [...sessions.entries()]
            .find(([, t]) => t === transport)?.[0];
          if (id) {
            sessions.delete(id);
            logger.info({ sessionId: id }, 'MCP session closed');
          }
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      }
    });

    // GET for SSE stream (Streamable HTTP spec)
    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: 'Invalid or missing session ID' });
        return;
      }

      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    // DELETE for session cleanup
    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.close();
        sessions.delete(sessionId);
        res.status(200).json({ message: 'Session closed' });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });

    app.listen(port, () => {
      logger.info({ port, transport: 'streamable-http' }, 'EquityMCP server running');
      logger.info(`MCP endpoint: http://localhost:${port}/mcp`);
      logger.info(`Health check: http://localhost:${port}/health`);
    });
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    await closeRedis();
    await closePool();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Server startup failed');
  process.exit(1);
});
