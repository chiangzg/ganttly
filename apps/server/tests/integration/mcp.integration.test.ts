/**
 * MCP `/mcp` endpoint integration test (spec §17 PR5 acceptance). Drives the
 * full Streamable HTTP path with a real PAT bearer via Fastify `inject`:
 *   list tools → create_tasks → search_tasks.
 *
 * Requires TEST_DATABASE_URL; self-skips otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEmptyFile } from '@ganttly/schema';
import { externalReferences, outboxEvents, projectOperations, projects } from '../../src/db/schema';
import { buildIntegrationServer, devLogin, type DevSession } from './helpers';

const dbUrl = process.env.TEST_DATABASE_URL;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: { tools?: { name: string }[]; content?: { type: string; text: string }[] };
  error?: { code: number; message: string };
}

describe.skipIf(!dbUrl)('MCP /mcp endpoint integration', () => {
  let app: FastifyInstance;
  let session: DevSession;
  let projectId: string;
  let bearer: string;

  beforeAll(async () => {
    app = await buildIntegrationServer();
    await app.db.delete(externalReferences);
    await app.db.delete(outboxEvents);
    await app.db.delete(projectOperations);
    await app.db.delete(projects);
    session = await devLogin(app);

    // Seed a project.
    const projectRes = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${session.workspaceId}/projects`,
      headers: {
        'idempotency-key': 'mcp-it-seed',
        cookie: `ganttly_session=${session.cookie}`,
      },
      payload: { file: createEmptyFile({ name: 'MCP E2E' }) },
    });
    projectId = (projectRes.json() as { summary: { id: string } }).summary.id;

    // Mint a PAT with read + write scopes.
    const patRes = await app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie: `ganttly_session=${session.cookie}` },
      payload: { name: 'mcp-it', scopes: ['project:read', 'task:write', 'workspace:read'] },
    });
    bearer = `Bearer ${(patRes.json() as { token: string }).token}`;
  });
  afterAll(async () => {
    await app.close();
  });

  async function mcp(id: number, method: string, params?: unknown): Promise<JsonRpcResponse> {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: bearer,
        host: 'localhost:3001',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id, method, params },
    });
    return res.json() as JsonRpcResponse;
  }

  it('rejects requests without a bearer token (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'localhost:3001',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects a disallowed Host header (403, DNS-rebinding defence)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: bearer,
        host: 'evil.example.com',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists all eleven tools', async () => {
    const res = await mcp(1, 'tools/list');
    expect(res.result?.tools).toBeDefined();
    const names = res.result!.tools!.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_workspaces',
        'list_projects',
        'get_project',
        'search_tasks',
        'get_task',
        'create_task',
        'create_tasks',
        'update_task',
        'move_task',
        'add_dependency',
        'remove_dependency',
      ]),
    );
    expect(names).toHaveLength(11);
  });

  it('creates tasks via create_tasks and finds them via search_tasks', async () => {
    const created = await mcp(2, 'tools/call', {
      name: 'create_tasks',
      arguments: {
        workspaceId: session.workspaceId,
        projectId,
        idempotencyKey: 'mcp-it-batch',
        tasks: [{ name: 'E2E task A' }, { name: 'E2E task B' }],
      },
    });
    expect(created.result?.content?.[0]?.text).toBeDefined();
    const outcome = JSON.parse(created.result!.content![0]!.text);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r: { created: boolean }) => r.created)).toBe(true);

    const searched = await mcp(3, 'tools/call', {
      name: 'search_tasks',
      arguments: { workspaceId: session.workspaceId, projectId },
    });
    const searchOut = JSON.parse(searched.result!.content![0]!.text);
    const names = searchOut.tasks.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['E2E task A', 'E2E task B']));
  });

  it('returns a soft isError for a read-only token calling a write tool', async () => {
    const roRes = await app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie: `ganttly_session=${session.cookie}` },
      payload: { name: 'mcp-it-ro', scopes: ['project:read'] },
    });
    const roBearer = `Bearer ${(roRes.json() as { token: string }).token}`;
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: roBearer,
        host: 'localhost:3001',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: {
            workspaceId: session.workspaceId,
            projectId,
            name: 'blocked',
            idempotencyKey: 'mcp-it-blocked',
          },
        },
      },
    });
    const body = res.json() as JsonRpcResponse;
    const text = body.result?.content?.[0]?.text ?? '';
    expect(text).toContain('task:write');
  });

  it('get_project returns the project summary', async () => {
    const res = await mcp(5, 'tools/call', {
      name: 'get_project',
      arguments: { workspaceId: session.workspaceId, projectId },
    });
    const out = JSON.parse(res.result!.content![0]!.text);
    expect(out.project.id).toBe(projectId);
  });
});
