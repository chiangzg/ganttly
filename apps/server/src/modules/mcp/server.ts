/**
 * MCP server factory (spec §10) — registers the eleven first-version tools on a
 * stateless {@link McpServer} backed by the Streamable HTTP transport.
 *
 * Tools resolve the caller from `extra.authInfo` (set by the `/mcp` route from
 * the Bearer PAT), enforce scope + workspace membership, then delegate to the
 * shared {@link ProjectApplicationService} (writes) or repository/read helpers
 * (reads). Domain errors are returned as soft `isError` results so the MCP Host
 * can surface them to the model rather than treating them as protocol failures.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  addDependencyInput,
  ApiErrorCode,
  createTaskInput,
  createTasksInput,
  getProjectInput,
  getTaskInput,
  listProjectsInput,
  moveTaskInput,
  removeDependencyInput,
  searchTasksInput,
  updateTaskInput,
} from '@ganttly/api-contract';
import type { AuthPrincipal } from '../../auth/principal';
import type { Db } from '../../db/client';
import { workspaces, workspaceMembers } from '../../db/schema';
import { hasScope, requireMembership, requireScope } from '../access';
import { HttpError } from '../errors';
import type { ProjectApplicationService } from '../projects/service';
import { getProjectRow, listProjectRows, type ProjectRow } from '../projects/repository';
import { buildSummary } from '../projects/summary';
import { getTaskDetail, searchTasksInFile } from '../projects/read';

interface CreateMcpServerDeps {
  db: Db;
  service: ProjectApplicationService;
}

type ToolContent = { type: 'text'; text: string };
type CallToolResult = { content: ToolContent[]; isError?: boolean };

/** Extract + validate the principal carried on the MCP request. */
function requireAuth(authInfo: unknown): AuthPrincipal {
  if (!authInfo) {
    throw new HttpError(ApiErrorCode.AUTH_REQUIRED, 'MCP request is not authenticated');
  }
  return authInfo as AuthPrincipal;
}

/**
 * Run `work` as the authenticated principal and shape the outcome (or a caught
 * domain error) as a tool result. Soft errors keep the JSON-RPC call succeeding
 * with `isError: true` so the Host can relay the message to the model.
 */
async function toolResult(
  authInfo: unknown,
  work: (principal: AuthPrincipal) => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const data = await work(requireAuth(authInfo));
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (err) {
    if (err instanceof HttpError) {
      return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    return { isError: true, content: [{ type: 'text', text: `INTERNAL: ${message}` }] };
  }
}

/** Surface a `task:write` scope failure before hitting the database. */
function withWriteScope(p: AuthPrincipal): AuthPrincipal {
  if (!hasScope(p, 'task:write')) {
    throw new HttpError(ApiErrorCode.FORBIDDEN, 'This token lacks the task:write scope');
  }
  return p;
}

function projectLabel(row: ProjectRow): string {
  const s = buildSummary(row);
  return `${s.name} (revision ${row.revision}, ${s.taskCount} tasks)`;
}

export interface McpHandle {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/**
 * Build the connected MCP server + transport. Stateless (no session id) so any
 * instance can serve any request — suitable for horizontal scaling (spec §10).
 */
export function createMcpServer(deps: CreateMcpServerDeps): McpHandle {
  const { db, service } = deps;
  const server = new McpServer({ name: 'ganttly', version: '1.0.0' });

  // --- read tools -----------------------------------------------------------
  server.registerTool(
    'list_workspaces',
    { description: 'List the workspaces the caller can access, with their role.' },
    (extra) =>
      toolResult(extra.authInfo, async (p) => {
        requireScope(p, 'workspace:read');
        const rows = await db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            kind: workspaces.kind,
            role: workspaceMembers.role,
          })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
          .where(eq(workspaceMembers.userId, p.userId));
        return { workspaces: rows };
      }),
  );

  server.registerTool(
    'list_projects',
    {
      description:
        'List projects in a workspace. Returns summaries (id/name/stats), not full documents.',
      inputSchema: listProjectsInput,
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) => {
        requireScope(p, 'project:read');
        const { workspaceId } = args;
        await requireMembership(db, p, workspaceId, 'viewer');
        const rows = await listProjectRows(db, workspaceId, {});
        return { projects: rows.map((r) => buildSummary(r)) };
      }),
  );

  server.registerTool(
    'get_project',
    {
      description:
        'Get a project summary: name, calendar, task/resource/baseline counts and revision.',
      inputSchema: getProjectInput.pick({ workspaceId: true, projectId: true }),
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) => {
        requireScope(p, 'project:read');
        const { workspaceId, projectId } = args;
        await requireMembership(db, p, workspaceId, 'viewer');
        const row = await getProjectRow(db, workspaceId, projectId);
        if (!row) throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
        return { project: buildSummary(row) };
      }),
  );

  server.registerTool(
    'search_tasks',
    {
      description:
        'Search tasks within a project by name/note, parent, progress range, dates or assignee. Paginated.',
      inputSchema: searchTasksInput,
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) => {
        requireScope(p, 'project:read');
        await requireMembership(db, p, args.workspaceId, 'viewer');
        const row = await getProjectRow(db, args.workspaceId, args.projectId);
        if (!row) throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
        return searchTasksInFile(row.fileJsonb as never, args);
      }),
  );

  server.registerTool(
    'get_task',
    {
      description: 'Get a single task with its parent, predecessors and direct children.',
      inputSchema: getTaskInput,
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) => {
        requireScope(p, 'project:read');
        await requireMembership(db, p, args.workspaceId, 'viewer');
        const row = await getProjectRow(db, args.workspaceId, args.projectId);
        if (!row) throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
        const detail = getTaskDetail(row.fileJsonb as never, args.taskId);
        if (!detail) throw new HttpError(ApiErrorCode.NOT_FOUND, 'Task not found');
        return detail;
      }),
  );

  // --- write tools ----------------------------------------------------------
  server.registerTool(
    'create_task',
    {
      description: 'Create a single task. Optional `source` deduplicates across re-submissions.',
      inputSchema: createTaskInput,
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) =>
        service.createTask({
          principal: withWriteScope(p),
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          input: args,
          requestId: randomUUID(),
        }),
      ),
  );

  server.registerTool(
    'create_tasks',
    {
      description: 'Create multiple tasks in one revision.',
      inputSchema: createTasksInput,
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) =>
        service.createTasks({
          principal: withWriteScope(p),
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          input: args,
          requestId: randomUUID(),
        }),
      ),
  );

  server.registerTool(
    'update_task',
    {
      description: 'Update whitelisted task fields (name/start/duration/progress/etc).',
      inputSchema: updateTaskInput,
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) =>
        service.updateTask({
          principal: withWriteScope(p),
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          input: args,
          requestId: randomUUID(),
        }),
      ),
  );

  server.registerTool(
    'move_task',
    {
      description:
        'Move a task under a new parent at first/last/before/after a sibling. Repacks sibling orders.',
      inputSchema: moveTaskInput,
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) =>
        service.moveTask({
          principal: withWriteScope(p),
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          input: args,
          requestId: randomUUID(),
        }),
      ),
  );

  server.registerTool(
    'add_dependency',
    {
      description:
        'Add a predecessor dependency (FS/SS/FF/SF) to a successor task, with cycle check.',
      inputSchema: addDependencyInput,
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) =>
        service.addDependency({
          principal: withWriteScope(p),
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          input: args,
          requestId: randomUUID(),
        }),
      ),
  );

  server.registerTool(
    'remove_dependency',
    {
      description: 'Remove the dependency edge between a successor and a predecessor task.',
      inputSchema: removeDependencyInput,
    },
    (args, extra) =>
      toolResult(extra.authInfo, async (p) =>
        service.removeDependency({
          principal: withWriteScope(p),
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          input: args,
          requestId: randomUUID(),
        }),
      ),
  );

  // Stateless + JSON responses: each POST returns a plain JSON-RPC result (no
  // SSE stream). SSE notifications land in PR6; v1 MCP only needs tool calls.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  return { server, transport };
}

export { projectLabel };
