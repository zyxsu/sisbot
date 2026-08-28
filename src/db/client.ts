import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type AppDatabase = PostgresJsDatabase<typeof schema>;

export interface DatabaseClient {
  readonly db: AppDatabase;
  readonly sql: postgres.Sql;
  close(): Promise<void>;
  checkHealth(): Promise<boolean>;
}

export function createDatabaseClient(
  connectionString: string,
  options?: postgres.Options<Record<string, never>>,
): DatabaseClient {
  const sql = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ...options,
  });

  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
    async checkHealth(): Promise<boolean> {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
  };
}
