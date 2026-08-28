import { defineConfig } from 'drizzle-kit';

if (typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/auib_monitor',
  },
});
