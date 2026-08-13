import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration. `generate` reads {@link ./src/db/schema.ts} and
 * emits SQL into {@link ./drizzle}; it needs no live database. `migrate`
 * (src/db/migrate.ts) applies those files at runtime using DATABASE_URL.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ganttly',
  },
  strict: true,
  verbose: true,
});
