import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from './db/connection.js';
import type { RedisClient } from './cache/redis.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { rootLogger } from './middleware/logger.js';

const logger = rootLogger.child({ module: 'server' });

/**
 * Plugin registration function signature.
 * Every tool domain module exports a function matching this type.
 */
export type PluginRegistrar = (
  server: McpServer,
  db: Pool,
  cache: RedisClient
) => void;

/**
 * Creates and configures the MCP server with all tool domains.
 *
 * To add a new tool domain:
 * 1. Create src/tools/your-domain.ts exporting registerTools()
 * 2. Import it below
 * 3. Add it to the pluginModules array
 * That's it. No other file changes needed.
 */
export async function createServer(
  db: Pool,
  cache: RedisClient
): Promise<McpServer> {
  const server = new McpServer({
    name: 'equity-mcp',
    version: '1.0.0',
  });

  // ================================================================
  // PLUGIN REGISTRATION
  // Import and register each tool domain here.
  // Each module exports: registerTools(server, db, cache)
  // ================================================================

  const pluginModules: Array<{
    name: string;
    register: PluginRegistrar;
  }> = [
    // Phase 3 tools — uncomment as each module is implemented:
    { name: 'company', register: (await import('./tools/company.js')).registerTools },
    { name: 'financials', register: (await import('./tools/financials.js')).registerTools },
    { name: 'valuation', register: (await import('./tools/valuation.js')).registerTools },
    { name: 'screening', register: (await import('./tools/screening.js')).registerTools },
    { name: 'technicals', register: (await import('./tools/technicals.js')).registerTools },
    { name: 'shareholding', register: (await import('./tools/shareholding.js')).registerTools },
    { name: 'corporate-actions', register: (await import('./tools/corporate-actions.js')).registerTools },
    { name: 'macro', register: (await import('./tools/macro.js')).registerTools },
    { name: 'portfolio', register: (await import('./tools/portfolio.js')).registerTools },
    { name: 'ai-native', register: (await import('./tools/ai-native.js')).registerTools },
  ];

  let totalTools = 0;
  for (const plugin of pluginModules) {
    try {
      plugin.register(server, db, cache);
      logger.info({ plugin: plugin.name }, 'Plugin registered');
      totalTools++;
    } catch (err) {
      logger.error({ plugin: plugin.name, err }, 'Plugin registration failed');
    }
  }

  // ================================================================
  // RESOURCES AND PROMPTS
  // ================================================================
  registerResources(server, db, cache);
  registerPrompts(server, db, cache);

  // ================================================================
  // PLACEHOLDER TOOL (remove once real tools are registered)
  // Proves the server is alive and responding to tool calls.
  // ================================================================

  server.tool(
    'health_check',
    'Returns the health status of the EquityMCP server including database connectivity, ' +
    'cache status, and registered tool count. Use this to verify the server is operational.',
    {},
    async () => {
      const dbHealthy = await checkDbQuick(db);
      const cacheHealthy = await checkCacheQuick(cache);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'healthy',
            database: dbHealthy ? 'connected' : 'disconnected',
            cache: cacheHealthy ? 'connected' : 'disconnected',
            registeredPlugins: pluginModules.length,
            version: '1.0.0',
            timestamp: new Date().toISOString(),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'get_server_info',
    'Returns information about the EquityMCP server: available tool domains, ' +
    'data coverage, and server capabilities. Call this first to understand what ' +
    'data and analysis tools are available.',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            name: 'EquityMCP',
            description: 'Indian equity market data for ~7000 listed companies',
            coverage: {
              companies: '~7000 BSE/NSE listed companies',
              financials: 'Up to 15 years of annual and quarterly data',
              prices: 'Daily OHLCV price history',
              ratios: '25+ financial ratios precomputed',
              indices: 'Nifty 50, Bank Nifty, sectoral indices',
              macro: 'RBI rates, inflation, GDP, FII/DII flows',
            },
            toolDomains: [
              'Company search and profiles',
              'Financial statements (P&L, Balance Sheet, Cash Flow)',
              'Valuation (DCF, multiples, intrinsic value)',
              'Stock screening with custom conditions',
              'Technical analysis (MA, RSI, MACD)',
              'Shareholding patterns and insider trades',
              'Corporate actions (dividends, splits, bonuses)',
              'Macro indicators and market overview',
              'Portfolio analysis and watchlists',
              'AI-native research tools',
            ],
            registeredPlugins: pluginModules.map((p) => p.name),
          }, null, 2),
        }],
      };
    }
  );

  logger.info(
    { pluginCount: pluginModules.length, toolsRegistered: totalTools + 2 },
    'MCP server created'
  );

  return server;
}

async function checkDbQuick(db: Pool): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function checkCacheQuick(cache: RedisClient): Promise<boolean> {
  try {
    const result = await cache.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}
