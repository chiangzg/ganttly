/**
 * Migration integration test (spec §16.2 / PR2 acceptance).
 *
 * Requires a live, empty PostgreSQL reachable via `TEST_DATABASE_URL`. When
 * unset, the suite self-skips so `pnpm -r test` stays green without a database.
 * CI provides a fresh Postgres service container and sets the variable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createMigrationClient } from '../../src/db/client';

const url = process.env.TEST_DATABASE_URL;
const migrationsFolder = new URL('../../drizzle', import.meta.url).pathname;

const EXPECTED_TABLES = [
  'users',
  'workspaces',
  'workspace_members',
  'projects',
  'project_operations',
  'outbox_events',
] as const;

describe.skipIf(!url)('drizzle migration (integration)', () => {
  const dbUrl = url!;
  let endMigrate: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const client = createMigrationClient(dbUrl);
    endMigrate = client.end;
    await migrate(client.db, { migrationsFolder });
  });

  afterAll(async () => {
    if (endMigrate) await endMigrate();
  });

  async function withClient<T>(
    fn: (db: ReturnType<typeof createMigrationClient>['db']) => Promise<T>,
  ) {
    const client = createMigrationClient(dbUrl);
    try {
      return await fn(client.db);
    } finally {
      await client.end();
    }
  }

  it('creates all six core tables', async () => {
    const rows = await withClient((db) =>
      db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public'`,
      ),
    );
    const names = new Set(rows.map((r) => r.table_name));
    for (const table of EXPECTED_TABLES) {
      expect(names.has(table), `expected table ${table} to exist`).toBe(true);
    }
  });

  it('creates the partial idempotency unique index (spec §6.2)', async () => {
    const rows = await withClient((db) =>
      db.execute<{ indexname: string }>(
        sql`select indexname from pg_indexes where schemaname = 'public' and indexname = ${'project_operations_idempotency_unique'}`,
      ),
    );
    expect(rows.length).toBe(1);
  });

  it('creates the three check constraints (spec §6.1)', async () => {
    const rows = await withClient((db) =>
      db.execute<{ conname: string }>(
        sql`select conname from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace`,
      ),
    );
    const names = new Set(rows.map((r) => r.conname));
    expect(names.has('workspaces_kind_check')).toBe(true);
    expect(names.has('workspace_members_role_check')).toBe(true);
    expect(names.has('project_operations_actor_type_check')).toBe(true);
  });

  it('is idempotent — re-running migrate is a no-op', async () => {
    const client = createMigrationClient(dbUrl);
    try {
      await expect(migrate(client.db, { migrationsFolder })).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });
});
