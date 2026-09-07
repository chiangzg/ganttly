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

    // Seed a project with two resources so search_resources has data.
    const file = createEmptyFile({ name: 'MCP E2E' });
    file.resources.push(
      { id: 'res-zhang', name: '张三', role: '前端' },
      { id: 'res-li', name: '李四', role: '设计' },
    );
    const projectRes = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${session.workspaceId}/projects`,
      headers: {
        'idempotency-key': 'mcp-it-seed',
        cookie: `ganttly_session=${session.cookie}`,
      },
      payload: { file },
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

  it('lists all twelve tools', async () => {
    const res = await mcp(1, 'tools/list');
    expect(res.result?.tools).toBeDefined();
    const names = res.result!.tools!.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_workspaces',
        'list_projects',
        'get_project',
        'search_tasks',
        'search_resources',
        'get_task',
        'create_task',
        'create_tasks',
        'update_task',
        'move_task',
        'add_dependency',
        'remove_dependency',
      ]),
    );
    expect(names).toHaveLength(12);
  });

  it('creates tasks via create_tasks and finds them via search_tasks', async () => {
    const created = await mcp(2, 'tools/call', {
      name: 'create_tasks',
      arguments: {
        workspaceId: session.workspaceId,
        projectId,
        idempotencyKey: 'mcp-it-batch',
        tasks: [
          { name: 'E2E task A', assignments: [{ resourceId: 'res-zhang', load: 80 }] },
          { name: 'E2E task B' },
        ],
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

  it('search_resources resolves a name to a resourceId usable in search_tasks', async () => {
    const found = await mcp(6, 'tools/call', {
      name: 'search_resources',
      arguments: { workspaceId: session.workspaceId, projectId, name: '张' },
    });
    const out = JSON.parse(found.result!.content![0]!.text);
    expect(out.resources).toHaveLength(1);
    expect(out.resources[0]).toMatchObject({ id: 'res-zhang', role: '前端', assignedTaskCount: 1 });

    const byRole = await mcp(7, 'tools/call', {
      name: 'search_resources',
      arguments: { workspaceId: session.workspaceId, projectId, role: '设计' },
    });
    const roleOut = JSON.parse(byRole.result!.content![0]!.text);
    expect(roleOut.resources.map((r: { id: string }) => r.id)).toEqual(['res-li']);

    const tasksOfZhang = await mcp(8, 'tools/call', {
      name: 'search_tasks',
      arguments: {
        workspaceId: session.workspaceId,
        projectId,
        assigneeResourceId: out.resources[0].id as string,
      },
    });
    const tasksOut = JSON.parse(tasksOfZhang.result!.content![0]!.text);
    expect(tasksOut.tasks.map((t: { name: string }) => t.name)).toEqual(['E2E task A']);
  });

  it('list_projects honours the query filter', async () => {
    const hit = await mcp(9, 'tools/call', {
      name: 'list_projects',
      arguments: { workspaceId: session.workspaceId, query: 'e2e' },
    });
    const hitOut = JSON.parse(hit.result!.content![0]!.text);
    expect(hitOut.projects.map((p: { id: string }) => p.id)).toContain(projectId);

    const miss = await mcp(10, 'tools/call', {
      name: 'list_projects',
      arguments: { workspaceId: session.workspaceId, query: 'no-such-project' },
    });
    const missOut = JSON.parse(miss.result!.content![0]!.text);
    expect(missOut.projects).toEqual([]);
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
