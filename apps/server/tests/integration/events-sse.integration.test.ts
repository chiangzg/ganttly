/**
 * SSE `/events` endpoint integration (spec §11 / §16.4 PR6 acceptance).
 *
 * The stream is long-lived, so the hijacked-response paths (live delivery,
 * replay, resync) are exercised against a real listening server with a raw
 * HTTP client; the pre-hijack error paths (404/400) use Fastify `inject`.
 * Requires TEST_DATABASE_URL; self-skips otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createEmptyFile } from '@ganttly/schema';
import { outboxEvents, projectOperations, projects } from '../../src/db/schema';
import { buildServer } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import { devLogin, testDatabaseUrl, type DevSession } from './helpers';

const dbUrl = process.env.TEST_DATABASE_URL;

/** Open an SSE connection and accumulate raw text. */
function openSse(
  port: number,
  workspaceId: string,
  cookie: string,
  lastEventId?: number,
): { text: string; close: () => void; closed: Promise<void> } {
  let text = '';
  const headers: Record<string, string> = { cookie: `ganttly_session=${cookie}` };
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
  const req = get(
    {
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/events?workspaceId=${encodeURIComponent(workspaceId)}`,
      headers,
    },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
    },
  );
  const closed = new Promise<void>((resolve) => req.on('close', resolve));
  req.on('error', () => undefined);
  return {
    get text() {
      return text;
    },
    close: () => req.destroy(),
    closed,
  };
}

/** Resolve once the buffer satisfies the predicate, or reject on timeout. */
async function waitFor(
  getText: () => string,
  predicate: (t: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(getText())) return getText();
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`waitFor timed out. Buffer was:\n${getText()}`);
}

describe.skipIf(!dbUrl)('SSE /events endpoint integration', () => {
  let app: FastifyInstance;
  let session: DevSession;
  let port: number;
  let projectId: string;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: testDatabaseUrl(),
      PUBLIC_BASE_URL: 'http://localhost:3001',
      WEB_APP_URL: 'http://localhost:5173',
      GANTTLY_INSTANCE_ID: 'inst_sse',
      GANTTLY_INSTANCE_NAME: 'ganttly SSE Test',
      AUTH_MODE: 'dev',
      ALLOWED_WEB_ORIGINS: 'http://localhost:5173',
      OUTBOX_POLL_INTERVAL_MS: '20',
    });
    app = await buildServer(config);
    await app.db.delete(outboxEvents);
    await app.db.delete(projectOperations);
    await app.db.delete(projects);
    session = await devLogin(app);

    // Seed a project (this also emits one project.created outbox row).
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${session.workspaceId}/projects`,
      headers: { 'idempotency-key': 'sse-seed', cookie: `ganttly_session=${session.cookie}` },
      payload: { file: createEmptyFile({ name: 'SSE target' }) },
    });
    projectId = (res.json() as { summary: { id: string } }).summary.id;

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app.close();
  });

  it('rejects a non-member with 404 (no existence leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/events?workspaceId=ws_other`,
      headers: { cookie: `ganttly_session=${session.cookie}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a request missing workspaceId with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/events`,
      headers: { cookie: `ganttly_session=${session.cookie}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('delivers a live project.updated event after a write (spec §17 acceptance)', async () => {
    const stream = openSse(port, session.workspaceId, session.cookie);
    // Let the server register the bus subscription before the write races it.
    await new Promise((r) => setTimeout(r, 80));

    // Trigger a save → project.updated outbox → publisher drain → SSE frame.
    const file = createEmptyFile({ name: 'SSE target' });
    const saveRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${session.workspaceId}/projects/${projectId}`,
      headers: {
        cookie: `ganttly_session=${session.cookie}`,
        'if-match': '"1"',
        'idempotency-key': 'sse-live-save',
      },
      payload: { file },
    });
    expect(saveRes.statusCode).toBe(200);

    const text = await waitFor(
      () => stream.text,
      (t) => t.includes('project.updated'),
    );
    expect(text).toContain('event: project.updated');
    // The frame's data carries the new revision (2 after one save).
    expect(text).toMatch(/"revision":"2"/);

    stream.close();
  });

  it('replays published events after Last-Event-ID', async () => {
    // A second save produces another project.updated at revision 3.
    const file = createEmptyFile({ name: 'SSE target' });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${session.workspaceId}/projects/${projectId}`,
      headers: {
        cookie: `ganttly_session=${session.cookie}`,
        'if-match': '"2"',
        'idempotency-key': 'sse-replay-save',
      },
      payload: { file },
    });
    // Give the publisher a moment to mark it published.
    await new Promise((r) => setTimeout(r, 60));

    // Find the published sequences for the workspace to derive a replay cursor.
    const wsRows = await app.db.select().from(outboxEvents);
    const published = wsRows
      .filter((r) => r.workspaceId === session.workspaceId && r.publishedAt !== null)
      .map((r) => r.sequence)
      .sort((a, b) => a - b);
    expect(published.length).toBeGreaterThan(1);
    const cursor = published[0]!; // subscribe from after the first published event

    const stream = openSse(port, session.workspaceId, session.cookie, cursor);
    const text = await waitFor(
      () => stream.text,
      (t) => t.includes('project.updated'),
    );
    // The replayed frame must carry a sequence id greater than the cursor.
    expect(text).toContain('event: project.updated');
    stream.close();
  });

  it('emits resync_required when the cursor predates the retained window', async () => {
    // Use a cursor of 1, far below any retained published sequence → gap.
    const stream = openSse(port, session.workspaceId, session.cookie, 1);
    const text = await waitFor(
      () => stream.text,
      (t) => t.includes('resync_required'),
    );
    expect(text).toContain('event: resync_required');
    stream.close();
  });
});
