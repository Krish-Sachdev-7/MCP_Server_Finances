import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from './db/connection.js';
import type { RedisClient } from './cache/redis.js';
import { z } from 'zod';
import { rootLogger } from './middleware/logger.js';

const logger = rootLogger.child({ module: 'prompts' });

/**
 * Registers MCP prompts on the server.
 * Prompts are reusable templates that guide agents through multi-step workflows.
 */
export function registerPrompts(
  server: McpServer,
  _db: Pool,
  _cache: RedisClient,
): void {
  // ================================================================
  // investment-analysis
  // ================================================================

  server.prompt(
    'investment-analysis',
    'Analyze a company as a potential investment',
    { ticker: z.string().describe('Company ticker symbol (e.g. RELIANCE, TCS, HDFCBANK)') },
    ({ ticker }) => {
      const t = ticker.toUpperCase().trim();
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Analyze ${t} as a potential investment.`,
              `Start by calling explain_company to get the company overview,`,
              `then get_financial_ratios for historical metrics,`,
              `calculate_dcf for intrinsic value,`,
              `and get_technical_summary for price action.`,
              `Synthesize into a balanced assessment covering business quality,`,
              `financial health, valuation attractiveness, and key risks.`,
            ].join(' '),
          },
        }],
      };
    },
  );

  // ================================================================
  // screen-builder
  // ================================================================

  server.prompt(
    'screen-builder',
    'Build a custom stock screen step by step',
    {},
    () => {
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              'Help me build a stock screen for the Indian equity market.',
              'Ask me about my investment criteria: what kind of companies am I looking for?',
              'What metrics matter to me (growth, value, quality, momentum)?',
              'What are my minimum thresholds?',
              'Then use run_screen to execute the screen and explain the results.',
            ].join(' '),
          },
        }],
      };
    },
  );

  // ================================================================
  // portfolio-review
  // ================================================================

  server.prompt(
    'portfolio-review',
    'Review and analyze an investment portfolio',
    {
      holdings: z.string().describe(
        'JSON array of holdings with ticker, quantity, avgPrice, buyDate. ' +
        'Example: [{"ticker":"TCS","quantity":50,"avgPrice":3200,"buyDate":"2023-01-15"}]',
      ),
    },
    ({ holdings }) => {
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Review this portfolio: ${holdings}.`,
              'Call analyze_portfolio for the current snapshot and diversification assessment,',
              'get_portfolio_returns for performance metrics,',
              'and suggest_rebalancing for improvement recommendations.',
              'Present a clear summary of portfolio health, performance vs benchmark,',
              'and specific actionable suggestions.',
            ].join(' '),
          },
        }],
      };
    },
  );

  // ================================================================
  // sector-deep-dive
  // ================================================================

  server.prompt(
    'sector-deep-dive',
    'Deep analysis of an Indian equity sector',
    { sector: z.string().describe('Sector name (e.g. Banking, IT, Pharma, Auto, FMCG)') },
    ({ sector }) => {
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Provide a deep analysis of the ${sector} sector in India.`,
              'Start with get_sector_overview for aggregate statistics,',
              'then use get_sector_rotation to check recent momentum.',
              'Identify the top 5 companies by market cap using search_companies with sector filter,',
              'and run explain_company on the top 2.',
              'Compare the sector\'s average PE and ROE to the broader market',
              'using get_macro_indicators for context.',
            ].join(' '),
          },
        }],
      };
    },
  );

  logger.info('MCP prompts registered (4 prompts)');
}
