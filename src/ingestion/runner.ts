/**
 * Pipeline runner — entry point for all data ingestion.
 *
 * Usage:
 *   npm run ingest:all              — run all pipelines
 *   npm run ingest:companies        — run a specific pipeline
 *
 * Each pipeline module in src/ingestion/ exports:
 *   { name: string, schedule: string, run: (db, options?) => Promise<IngestResult> }
 *
 * To add a new pipeline:
 * 1. Create src/ingestion/your-pipeline.ts
 * 2. Export name, schedule, and run()
 * 3. Import it in the PIPELINES array below
 */

import 'dotenv/config';
import { getPool, closePool } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { updatePipelineStatus } from '../db/queries.js';
import { rootLogger } from '../middleware/logger.js';

const logger = rootLogger.child({ module: 'ingestion' });

export interface IngestResult {
  recordsProcessed: number;
  recordsInserted: number;
  recordsUpdated: number;
  errors: string[];
  durationMs: number;
}

export interface IngestPipeline {
  name: string;
  schedule: string; // cron expression
  run(db: import('pg').Pool, options?: Record<string, unknown>): Promise<IngestResult>;
}

// ================================================================
// PIPELINE REGISTRY
// Import pipelines here as they are built in Phase 2.
// ================================================================

// Dynamic imports to avoid circular dependencies and allow partial builds
async function loadPipelines(): Promise<IngestPipeline[]> {
  const companies = await import('./companies.js');
  const financials = await import('./financials.js');
  const prices = await import('./prices.js');
  const shareholding = await import('./shareholding.js');
  const corporateActions = await import('./corporate-actions.js');
  const insiderTrades = await import('./insider-trades.js');
  const macro = await import('./macro.js');

  return [
    { name: companies.name, schedule: companies.schedule, run: companies.run },
    { name: financials.name, schedule: financials.schedule, run: financials.run },
    { name: prices.name, schedule: prices.schedule, run: prices.run },
    { name: shareholding.name, schedule: shareholding.schedule, run: shareholding.run },
    { name: corporateActions.name, schedule: corporateActions.schedule, run: corporateActions.run },
    { name: insiderTrades.name, schedule: insiderTrades.schedule, run: insiderTrades.run },
    { name: macro.name, schedule: macro.schedule, run: macro.run },
  ];
}

let PIPELINES: IngestPipeline[] = [];

async function runPipeline(pipeline: IngestPipeline): Promise<void> {
  const db = getPool();
  logger.info({ pipeline: pipeline.name }, 'Starting pipeline');

  await updatePipelineStatus(db, pipeline.name, 'running');

  const start = Date.now();
  try {
    const result = await pipeline.run(db);
    const durationMs = Date.now() - start;

    await updatePipelineStatus(db, pipeline.name, 'success', {
      recordsProcessed: result.recordsProcessed,
      recordsInserted: result.recordsInserted,
      recordsUpdated: result.recordsUpdated,
      durationMs,
    });

    logger.info({
      pipeline: pipeline.name,
      ...result,
      durationMs,
    }, 'Pipeline completed');

    if (result.errors.length > 0) {
      logger.warn({
        pipeline: pipeline.name,
        errorCount: result.errors.length,
        sampleErrors: result.errors.slice(0, 5),
      }, 'Pipeline completed with errors');
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : String(err);

    await updatePipelineStatus(db, pipeline.name, 'failed', {
      durationMs,
      errorMessage,
    });

    logger.error({ pipeline: pipeline.name, err, durationMs }, 'Pipeline failed');
    throw err;
  }
}

// ================================================================
// CLI ENTRY POINT
// ================================================================

async function main(): Promise<void> {
  await runMigrations();
  PIPELINES = await loadPipelines();

  const args = process.argv.slice(2);
  const allFlag = args.includes('--all');
  const pipelineArg = args.find((a) => a.startsWith('--pipeline='));
  const targetName = pipelineArg?.split('=')[1];

  if (PIPELINES.length === 0) {
    logger.warn(
      'No pipelines registered yet. Uncomment pipeline imports in ' +
      'src/ingestion/runner.ts as you build them in Phase 2.'
    );
    return;
  }

  if (allFlag) {
    logger.info({ count: PIPELINES.length }, 'Running all pipelines');
    for (const pipeline of PIPELINES) {
      try {
        await runPipeline(pipeline);
      } catch {
        // Error already logged, continue with next pipeline
      }
    }
  } else if (targetName) {
    const pipeline = PIPELINES.find((p) => p.name === targetName);
    if (!pipeline) {
      logger.error(
        { target: targetName, available: PIPELINES.map((p) => p.name) },
        'Pipeline not found'
      );
      process.exit(1);
    }
    await runPipeline(pipeline);
  } else {
    logger.error('Usage: --all or --pipeline=<name>');
    logger.info({ available: PIPELINES.map((p) => p.name) }, 'Available pipelines');
    process.exit(1);
  }
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Ingestion runner failed');
    process.exit(1);
  })
  .finally(async () => {
    await closePool();
  });
