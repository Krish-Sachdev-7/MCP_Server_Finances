import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from './db/connection.js';
import type { RedisClient } from './cache/redis.js';
import * as queries from './db/queries.js';
import { rootLogger } from './middleware/logger.js';

const logger = rootLogger.child({ module: 'resources' });

/**
 * Registers MCP resources on the server.
 * Resources are read-only data URIs that clients can list and read.
 */
export function registerResources(
  server: McpServer,
  db: Pool,
  _cache: RedisClient,
): void {
  // ================================================================
  // STATIC RESOURCES (no URI template variables)
  // ================================================================

  server.resource(
    'market-overview',
    'equity://market/overview',
    { description: 'Current Indian equity market overview', mimeType: 'application/json' },
    async (uri) => {
      try {
        const macroRows = await queries.getMacroIndicators(db, 1);
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              description: 'Indian equity market overview from latest macro indicators',
              data: macroRows,
              timestamp: new Date().toISOString(),
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ err }, 'Failed to read market-overview resource');
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Failed to fetch market overview' }),
          }],
        };
      }
    },
  );

  server.resource(
    'macro-latest',
    'equity://macro/latest',
    { description: 'Latest Indian macroeconomic indicators', mimeType: 'application/json' },
    async (uri) => {
      try {
        const rows = await queries.getMacroIndicators(db, 3);
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              description: 'Latest Indian macroeconomic indicators (3 months)',
              data: rows,
              timestamp: new Date().toISOString(),
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ err }, 'Failed to read macro-latest resource');
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Failed to fetch macro indicators' }),
          }],
        };
      }
    },
  );

  // ================================================================
  // TEMPLATE RESOURCES (parameterized with {ticker})
  // ================================================================

  const companyTemplate = new ResourceTemplate(
    'equity://company/{ticker}',
    { list: undefined },
  );

  server.resource(
    'company-profile',
    companyTemplate,
    { description: 'Company profile for an Indian listed equity', mimeType: 'application/json' },
    async (uri, variables) => {
      try {
        const ticker = String(variables.ticker).toUpperCase().trim();
        const company = await queries.getCompanyByTicker(db, ticker);
        if (!company) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: `Company not found: ${ticker}` }),
            }],
          };
        }
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              description: `Profile for ${ticker}`,
              data: company,
              timestamp: new Date().toISOString(),
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ err, ticker: variables.ticker }, 'Failed to read company-profile resource');
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Failed to fetch company profile' }),
          }],
        };
      }
    },
  );

  const annualTemplate = new ResourceTemplate(
    'equity://financials/{ticker}/annual',
    { list: undefined },
  );

  server.resource(
    'annual-financials',
    annualTemplate,
    { description: 'Annual financial statements', mimeType: 'application/json' },
    async (uri, variables) => {
      try {
        const ticker = String(variables.ticker).toUpperCase().trim();
        const company = await queries.getCompanyByTicker(db, ticker);
        if (!company) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: `Company not found: ${ticker}` }),
            }],
          };
        }
        const companyId = (company as Record<string, unknown>).id as number;
        const financials = await queries.getAnnualFinancials(db, companyId, 5);
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              description: `Annual financials for ${ticker} (5 years)`,
              data: financials,
              timestamp: new Date().toISOString(),
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ err, ticker: variables.ticker }, 'Failed to read annual-financials resource');
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Failed to fetch annual financials' }),
          }],
        };
      }
    },
  );

  const quarterlyTemplate = new ResourceTemplate(
    'equity://financials/{ticker}/quarterly',
    { list: undefined },
  );

  server.resource(
    'quarterly-financials',
    quarterlyTemplate,
    { description: 'Quarterly financial results', mimeType: 'application/json' },
    async (uri, variables) => {
      try {
        const ticker = String(variables.ticker).toUpperCase().trim();
        const company = await queries.getCompanyByTicker(db, ticker);
        if (!company) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: `Company not found: ${ticker}` }),
            }],
          };
        }
        const companyId = (company as Record<string, unknown>).id as number;
        const financials = await queries.getQuarterlyFinancials(db, companyId, 8);
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              description: `Quarterly financials for ${ticker} (8 quarters)`,
              data: financials,
              timestamp: new Date().toISOString(),
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ err, ticker: variables.ticker }, 'Failed to read quarterly-financials resource');
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Failed to fetch quarterly financials' }),
          }],
        };
      }
    },
  );

  logger.info('MCP resources registered (2 static + 3 templates)');
}
