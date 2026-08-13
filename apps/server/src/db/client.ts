/**
 * Drizzle client factory backed by postgres.js (spec §3.1).
 *
 * One connection pool per process. The Fastify `database` plugin decorates the
 * instance with the created {@link Db}; the migration runner and tests build
 * their own short-lived clients.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

export interface CreateDbOptions {
  /** Max pool connections. Default 10 for the API; use 1 for migrations. */
  max?: number;
}

export function createDb(databaseUrl: string, options: CreateDbOptions = {}) {
  const client = postgres(databaseUrl, {
    max: options.max ?? 10,
    // SSL is controlled via the `sslmode` query param in DATABASE_URL.
  });
  return drizzle(client, { schema });
}

/**
 * A raw postgres.js client (no ORM) for the migration runner, which uses
 * `drizzle-orm/postgres-js/migrator`. Returned with an explicit `end()` so the
 * process can exit cleanly.
 */
export function createMigrationClient(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);
  return {
    db,
    end: () => sql.end({ timeout: 5 }),
  };
}
