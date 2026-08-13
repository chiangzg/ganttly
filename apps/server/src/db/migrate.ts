/**
 * Migration runner — `pnpm migrate` / `pnpm --filter @ganttly/server migrate`.
 *
 * Applies every SQL file in `./drizzle` (produced by `drizzle-kit generate`) to
 * the configured database. Exits non-zero on failure so CI/deploy blocks.
 *
 * Per spec §14.1 this is an explicit release step; the API process does NOT
 * auto-run migrations on boot.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig } from '../config';
import { createMigrationClient } from './client';

async function main() {
  const cfg = loadConfig();
  const { db, end } = createMigrationClient(cfg.databaseUrl);
  try {
    await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
    // eslint-disable-next-line no-console
    console.log('[migrate] migrations applied successfully');
  } finally {
    await end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
