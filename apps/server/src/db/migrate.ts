/**
 * Migration runner — `pnpm migrate` / `pnpm --filter @ganttly/server migrate`.
 *
 * Applies every SQL file in `./drizzle` (produced by `drizzle-kit generate`) to
 * the configured database. Exits non-zero on failure so CI/deploy blocks.
 *
 * Per spec §14.1 this is an explicit release step; the API process does NOT
 * auto-run migrations on boot.
 *
 * `MIGRATIONS_FOLDER` lets the esbuild-bundled `dist/migrate.js` locate the
 * shipped SQL without relying on `import.meta.url` (whose relative path differs
 * between `src/db/` and the flat `dist/` output). Unset, it falls back to the
 * source-relative path used by `tsx` in development.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig } from '../config';
import { createMigrationClient } from './client';

function migrationsFolder(): string {
  if (process.env.MIGRATIONS_FOLDER && process.env.MIGRATIONS_FOLDER.trim() !== '') {
    return process.env.MIGRATIONS_FOLDER;
  }
  return new URL('../../drizzle', import.meta.url).pathname;
}

async function main() {
  const cfg = loadConfig();
  const { db, end } = createMigrationClient(cfg.databaseUrl);
  try {
    await migrate(db, { migrationsFolder: migrationsFolder() });
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
