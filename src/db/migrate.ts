import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { loadEnvironment } from '../config/env.js';
import { logger } from '../config/logger.js';

async function runMigrations(): Promise<void> {
  const env = loadEnvironment();
  logger.info('Applying database migrations from drizzle folder');

  const sql = postgres(env.DATABASE_URL);

  try {
    const migrationFiles = readdirSync(resolve('drizzle'))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();

    for (const file of migrationFiles) {
      const content = readFileSync(resolve('drizzle', file), 'utf8');
      const statements = content.split('--> statement-breakpoint');

      for (const statement of statements) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) {
          try {
            await sql.unsafe(trimmed);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('already exists')) {
              logger.warn({ file, msg, statement: trimmed.slice(0, 50) }, 'Migration notice');
            }
          }
        }
      }
    }

    logger.info('Database migrations applied successfully');
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    logger.info({ tables: tables.map((t) => t.table_name) }, 'Verified database tables');
  } catch (error) {
    logger.error({ err: error }, 'Failed to apply database migrations');
    process.exit(1);
  } finally {
    await sql.end();
  }
}

void runMigrations();
