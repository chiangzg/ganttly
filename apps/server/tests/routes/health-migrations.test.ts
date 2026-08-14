import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/bootstrap';
import { buildTestConfig } from '../helpers';
import type { Db } from '../../src/db/client';

/**
 * /health/ready migration version check (spec §14.2). The handler pings the DB
 * then compares the applied migration count in `drizzle.__drizzle_migrations`
 * against the migrations shipped with the image. Here we inject a mock DB so the
 * three states (ok / behind / missing) are exercised without mutating a real
 * database — the live happy path is covered by the DB-gated integration suite.
 */
describe('/health/ready migration check', () => {
  let app: FastifyInstance;

  // Mutable mock state: `call` resets before each request so the first execute
  // answers the `select 1` liveness probe and the second answers the count query.
  let call = 0;
  let mode: 'ok' | 'behind' | 'missing' = 'ok';

  const db = {
    execute: async () => {
      call++;
      if (call === 1) return []; // liveness probe
      if (mode === 'missing')
        throw new Error('relation "drizzle.__drizzle_migrations" does not exist');
      return [{ n: mode === 'ok' ? 2 : 1 }];
    },
  } as unknown as Db;

  beforeAll(async () => {
    app = await buildServer(buildTestConfig(), { registerDatabase: false });
    app.decorate('db', db);
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports migrations:ok when applied matches the shipped count', async () => {
    call = 0;
    mode = 'ok';
    // Shipped migrations on this branch = 2 (0000 + 0001).
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { database: 'ok', migrations: 'ok' } });
  });

  it('reports 503 migrations:behind when applied < shipped', async () => {
    call = 0;
    mode = 'behind';
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.checks).toMatchObject({ database: 'ok', migrations: 'behind' });
    expect(body.checks.expected).toBe(2);
    expect(body.checks.applied).toBe(1);
  });

  it('reports 503 migrations:missing when the migrations table is absent', async () => {
    call = 0;
    mode = 'missing';
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ database: 'ok', migrations: 'missing' });
  });
});

describe('MIGRATIONS_FOLDER override (Docker image layout)', () => {
  let app: FastifyInstance;
  const dir = mkdtempSync(join(tmpdir(), 'ganttly-migrations-'));
  // Four shipped SQL files + a non-SQL file that must not be counted.
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, `000${i}_x.sql`), '');
  writeFileSync(join(dir, 'meta.json'), '{}');

  let call = 0;
  const db = {
    execute: async () => {
      call++;
      if (call === 1) return []; // liveness probe
      return [{ n: 3 }]; // DB has 3 applied, folder ships 4 → behind
    },
  } as unknown as Db;

  beforeAll(async () => {
    process.env.MIGRATIONS_FOLDER = dir;
    app = await buildServer(buildTestConfig(), { registerDatabase: false });
    app.decorate('db', db);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.MIGRATIONS_FOLDER;
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts the SQL files from MIGRATIONS_FOLDER and reports behind', async () => {
    call = 0;
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.checks).toMatchObject({ database: 'ok', migrations: 'behind' });
    expect(body.checks.expected).toBe(4);
    expect(body.checks.applied).toBe(3);
  });
});
