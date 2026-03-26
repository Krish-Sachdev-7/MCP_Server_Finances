import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './connection.js';
import { pino } from 'pino';

const logger = pino({ name: 'migrate' });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  let files: string[];

  try {
    files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    // In production, migrations may be at a different path
    const altDir = path.resolve(process.cwd(), 'build', 'db', 'migrations');
    if (fs.existsSync(altDir)) {
      files = fs.readdirSync(altDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } else {
      logger.warn('No migrations directory found');
      return;
    }
  }

  const { rows: applied } = await pool.query(
    'SELECT filename FROM schema_migrations'
  );
  const appliedSet = new Set(applied.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) {
      logger.debug({ file }, 'Migration already applied');
      continue;
    }

    const filePath = fs.existsSync(path.join(migrationsDir, file))
      ? path.join(migrationsDir, file)
      : path.join(process.cwd(), 'build', 'db', 'migrations', file);

    const sql = fs.readFileSync(filePath, 'utf-8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      logger.info({ file }, 'Migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ file, err }, 'Migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info('All migrations applied');
}

// Allow running directly: tsx src/db/migrate.ts
const isMain = process.argv[1]?.includes('migrate');
if (isMain) {
  (async () => {
    try {
      const dotenv = await import('dotenv');
      dotenv.config();
      await runMigrations();
      logger.info('Migration complete');
    } catch (err) {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    } finally {
      await closePool();
    }
  })();
}
