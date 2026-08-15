import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type * as inject from 'light-my-request';
import { createDefaultTask, createEmptyFile } from '@ganttly/schema';
import { newProjectId, newUserId, newWorkspaceId } from '../../src/id';
import { createDb } from '../../src/db/client';
import {
  outboxEvents,
  projectOperations,
  projects,
  users,
  workspaces,
  workspaceMembers,
} from '../../src/db/schema';
import { buildIntegrationServer, devLogin, type DevSession } from './helpers';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('project API integration', () => {
  let app: FastifyInstance;
  let session: DevSession;

  beforeAll(async () => {
    app = await buildIntegrationServer();
    // Start each run with a clean project slate (users/workspaces survive).
    // createEmptyFile stamps the current time, so reusing static idempotency
    // keys across runs would otherwise look like a changed request (409).
    await app.db.delete(outboxEvents);
    await app.db.delete(projectOperations);
    await app.db.delete(projects);
    session = await devLogin(app);
  });
  afterAll(async () => {
    await app.close();
  });

  function projectsUrl(path = ''): string {
    return `/api/v1/workspaces/${session.workspaceId}/projects${path}`;
  }

  async function authed(opts: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }): Promise<inject.Response> {
    // Replay the session cookie via the raw Cookie header: secure-session
    // values are URL-encoded, and inject's `cookies` object double-encodes
    // them. A browser sends the Set-Cookie value verbatim, so we mirror that.
    const options: inject.InjectOptions = {
      method: opts.method,
      url: opts.url,
      headers: { ...opts.headers, cookie: `ganttly_session=${session.cookie}` },
    };
    if (opts.payload !== undefined) {
      options.payload = opts.payload as inject.InjectPayload;
    }
    return app.inject(options);
  }

  it('rejects unauthenticated project access with 401', async () => {
    const res = await app.inject({ method: 'GET', url: projectsUrl() });
    expect(res.statusCode).toBe(401);
  });

  it('creates a project, serves it with ETag, and bumps revision on save', async () => {
    const file = createEmptyFile({ name: 'Roadmap' });
    const created = await authed({
      method: 'POST',
      url: projectsUrl(),
      headers: { 'idempotency-key': 'k-create-rev' },
      payload: { file },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project.revision).toBe('1');
    expect(project.summary.name).toBe('Roadmap');
    const projectId = project.summary.id;

    const got = await authed({ method: 'GET', url: projectsUrl(`/${projectId}`) });
    expect(got.statusCode).toBe(200);
    expect(got.headers.etag).toBe('"1"');

    // Save with the correct If-Match → revision 2.
    file.project.name = 'Roadmap v2';
    const saved = await authed({
      method: 'PUT',
      url: projectsUrl(`/${projectId}`),
      headers: { 'if-match': '"1"' },
      payload: { file },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().revision).toBe('2');
    expect(saved.headers.etag).toBe('"2"');

    // Stale If-Match → 412 with the actual revision.
    const conflict = await authed({
      method: 'PUT',
      url: projectsUrl(`/${projectId}`),
      headers: { 'if-match': '"1"' },
      payload: { file },
    });
    expect(conflict.statusCode).toBe(412);
    expect(conflict.json().error.code).toBe('REVISION_CONFLICT');
    expect(conflict.json().error.details.actualRevision).toBe('2');
  });

  it('replays an identical idempotent request and conflicts on a changed body', async () => {
    const file = createEmptyFile({ name: 'Idem' });
    const first = await authed({
      method: 'POST',
      url: projectsUrl(),
      headers: { 'idempotency-key': 'k-idem-replay' },
      payload: { file },
    });
    expect(first.statusCode).toBe(201);

    const replay = await authed({
      method: 'POST',
      url: projectsUrl(),
      headers: { 'idempotency-key': 'k-idem-replay' },
      payload: { file },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().summary.id).toBe(first.json().summary.id);

    const divergent = await authed({
      method: 'POST',
      url: projectsUrl(),
      headers: { 'idempotency-key': 'k-idem-replay' },
      payload: { file: createEmptyFile({ name: 'Different' }) },
    });
    expect(divergent.statusCode).toBe(409);
    expect(divergent.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('imports, archives, lists trash, restores, and permanently deletes', async () => {
    const file = createEmptyFile({ name: 'Imported' });
    const imported = await authed({
      method: 'POST',
      url: projectsUrl('/import'),
      headers: { 'idempotency-key': 'k-import-flow' },
      payload: { name: 'Imported Renamed', file },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().summary.name).toBe('Imported Renamed');
    const projectId = imported.json().summary.id;

    const archived = await authed({
      method: 'POST',
      url: projectsUrl(`/${projectId}/archive`),
      headers: { 'idempotency-key': 'k-archive' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().summary.deletedAt).not.toBeNull();

    const active = await authed({ method: 'GET', url: projectsUrl() });
    expect(
      (active.json().projects as Array<{ id: string }>).find((p) => p.id === projectId),
    ).toBeUndefined();

    const trash = await authed({ method: 'GET', url: projectsUrl('?deleted=true') });
    expect(
      (trash.json().projects as Array<{ id: string }>).find((p) => p.id === projectId),
    ).toBeDefined();

    const restored = await authed({
      method: 'POST',
      url: projectsUrl(`/${projectId}/restore`),
      headers: { 'idempotency-key': 'k-restore' },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().summary.deletedAt).toBeNull();

    // Permanent delete requires prior archive.
    const prematureDelete = await authed({ method: 'DELETE', url: projectsUrl(`/${projectId}`) });
    expect(prematureDelete.statusCode).toBe(422);

    await authed({
      method: 'POST',
      url: projectsUrl(`/${projectId}/archive`),
      headers: { 'idempotency-key': 'k-archive-2' },
    });
    const deleted = await authed({ method: 'DELETE', url: projectsUrl(`/${projectId}`) });
    expect(deleted.statusCode).toBe(204);
  });

  it('returns 404 (not 403) for a project in another workspace (IDOR)', async () => {
    const db = createDb(dbUrl!);
    try {
      const otherUserId = newUserId();
      const otherWsId = newWorkspaceId();
      const otherProjectId = newProjectId();
      const now = new Date();
      await db.insert(users).values({
        id: otherUserId,
        provider: 'https://other.example',
        subject: `other-${otherProjectId}`,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(workspaces).values({
        id: otherWsId,
        name: 'Other',
        kind: 'personal',
        createdBy: otherUserId,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(workspaceMembers).values({
        workspaceId: otherWsId,
        userId: otherUserId,
        role: 'owner',
        createdAt: now,
      });
      await db.insert(projects).values({
        id: otherProjectId,
        workspaceId: otherWsId,
        name: 'Secret',
        fileJsonb: createEmptyFile({ name: 'Secret' }),
        summaryJsonb: { taskCount: 0, completedTaskCount: 0, progress: 0 },
        revision: 1,
        createdBy: otherUserId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      // Reach for the other project via our own workspace — scoped out → 404.
      const viaOwnWs = await authed({
        method: 'GET',
        url: projectsUrl(`/${otherProjectId}`),
      });
      expect(viaOwnWs.statusCode).toBe(404);

      // Reach via the other workspace id directly — not a member → 404.
      const viaOtherWs = await authed({
        method: 'GET',
        url: `/api/v1/workspaces/${otherWsId}/projects/${otherProjectId}`,
      });
      expect(viaOtherWs.statusCode).toBe(404);
    } finally {
      await db.$client.end({ timeout: 5 });
    }
  });

  it('applies a structured command and returns affected task ids', async () => {
    const file = createEmptyFile({ name: 'Cmd' });
    const created = await authed({
      method: 'POST',
      url: projectsUrl(),
      headers: { 'idempotency-key': 'k-cmd-create' },
      payload: { file },
    });
    const projectId = created.json().summary.id;

    const task = createDefaultTask({
      id: 't1',
      name: 'First task',
      start: '2026-01-01',
      parentId: null,
      order: 0,
    });
    const res = await authed({
      method: 'POST',
      url: projectsUrl(`/${projectId}/commands`),
      headers: { 'idempotency-key': 'k-cmd-add' },
      payload: { command: { kind: 'addTask', task, parentId: null, order: 0 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.affectedTaskIds).toContain('t1');
    expect(body.revision).toBe('2');
  });
});
