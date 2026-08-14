/**
 * MCP v1 tool input contract (spec §10).
 *
 * Zod raw shapes for the eleven first-version MCP tools. These are the single
 * source of truth for tool input validation: the server registers them via
 * `McpServer.registerTool` and the contract tests assert accept/reject
 * behaviour, so Web, MCP Host and tests all agree on the exact field set.
 *
 * Tool outputs reuse {@link ProjectSummary} / {@link ApplyCommandResponse} from
 * `./project`; MCP-specific response shaping (e.g. `created: boolean`) is
 * defined here as TypeScript interfaces only — the SDK validates output
 * against the per-tool `outputSchema` registered in the server.
 */
import { z } from 'zod';
import type { TaskConstraints } from '@ganttly/schema';

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/**
 * Stable external linkage for deduplication (spec §6.4 / §10.3 `source`). When
 * a create call carries a `source` that already maps to an existing entity,
 * the server returns the existing task with `created=false` instead of
 * creating a duplicate. The server only persists the URL; it never fetches it.
 */
export const externalSourceSchema = z.object({
  provider: z.string().min(1).max(120),
  externalId: z.string().min(1).max(512),
  url: z.string().url().optional(),
});
export type ExternalSource = z.infer<typeof externalSourceSchema>;

/** Dependency edge input (user-facing names; mapped to domain `Dependency`). */
export const dependencyInputSchema = z.object({
  /** The PREDECESSOR task this task depends on. */
  predecessorTaskId: z.string().min(1),
  type: z.enum(['FS', 'SS', 'FF', 'SF']).optional(),
  /** Lag in working days; may be negative (lead). Defaults to 0. */
  lag: z.number().int().optional(),
});

export const assignmentInputSchema = z.object({
  resourceId: z.string().min(1),
  /** Percent allocation 0-100. */
  load: z.number().min(0).max(100),
});

/** ISO date `YYYY-MM-DD`. */
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

// ---------------------------------------------------------------------------
// Read tool inputs
// ---------------------------------------------------------------------------

export const listWorkspacesInput = z.object({});
export type ListWorkspacesInput = z.infer<typeof listWorkspacesInput>;

export const listProjectsInput = z.object({
  workspaceId: z.string().min(1),
  query: z.string().optional(),
});
export type ListProjectsInput = z.infer<typeof listProjectsInput>;

export const getProjectInput = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
});
export type GetProjectInput = z.infer<typeof getProjectInput>;

export const searchTasksInput = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().optional(),
  note: z.string().optional(),
  parentTaskId: z.string().nullable().optional(),
  progressMin: z.number().min(0).max(100).optional(),
  progressMax: z.number().min(0).max(100).optional(),
  startFrom: dateString.optional(),
  startTo: dateString.optional(),
  assigneeResourceId: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type SearchTasksInput = z.infer<typeof searchTasksInput>;

export const getTaskInput = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
});
export type GetTaskInput = z.infer<typeof getTaskInput>;

// ---------------------------------------------------------------------------
// Write tool inputs
// ---------------------------------------------------------------------------

/**
 * The task-creation fragment shared by `create_task` and `create_tasks`.
 * Excludes `workspaceId`/`projectId`/`idempotencyKey` (call-scoped) so the
 * batch tool can carry many items without repeating them.
 */
export const createTaskItemSchema = z.object({
  name: z.string().min(1),
  parentTaskId: z.string().min(1).nullable().optional(),
  afterTaskId: z.string().min(1).nullable().optional(),
  start: dateString.optional(),
  duration: z.number().int().min(1).optional(),
  isMilestone: z.boolean().optional(),
  progress: z.number().min(0).max(100).optional(),
  note: z.string().optional(),
  color: z.string().optional(),
  assignments: z.array(assignmentInputSchema).optional(),
  dependencies: z.array(dependencyInputSchema).optional(),
  source: externalSourceSchema.optional(),
});
export type CreateTaskItem = z.infer<typeof createTaskItemSchema>;

export const createTaskInput = createTaskItemSchema.extend({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256),
});
export type CreateTaskInput = z.infer<typeof createTaskInput>;

export const createTasksInput = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  tasks: z.array(createTaskItemSchema).min(1).max(200),
  idempotencyKey: z.string().min(1).max(256),
});
export type CreateTasksInput = z.infer<typeof createTasksInput>;

/**
 * `update_task` (spec §10.4). Only the listed fields may change; moving or
 * rewiring dependencies uses `move_task` / dependency tools. At least one field
 * must be present — an empty patch is a validation error and produces no
 * revision.
 */
export const updateTaskInput = z
  .object({
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    name: z.string().min(1).optional(),
    start: dateString.optional(),
    duration: z.number().int().min(1).optional(),
    progress: z.number().min(0).max(100).optional(),
    isMilestone: z.boolean().optional(),
    note: z.string().optional(),
    color: z.string().optional(),
    overtimeDates: z.array(dateString).optional(),
    constraints: z.custom<TaskConstraints>().optional(),
    assignments: z.array(assignmentInputSchema).optional(),
    idempotencyKey: z.string().min(1).max(256),
  })
  .refine(
    (value) =>
      Object.keys(value).some(
        (k) => k !== 'workspaceId' && k !== 'projectId' && k !== 'taskId' && k !== 'idempotencyKey',
      ),
    { message: 'update_task requires at least one field to change' },
  );
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;

/** Where to place a task relative to its new siblings (spec §10.5). */
export const movePositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('first') }),
  z.object({ kind: z.literal('last') }),
  z.object({ kind: z.literal('before'), taskId: z.string().min(1) }),
  z.object({ kind: z.literal('after'), taskId: z.string().min(1) }),
]);
export type MovePosition = z.infer<typeof movePositionSchema>;

export const moveTaskInput = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  newParentTaskId: z.string().min(1).nullable(),
  position: movePositionSchema,
  idempotencyKey: z.string().min(1).max(256),
});
export type MoveTaskInput = z.infer<typeof moveTaskInput>;

export const addDependencyInput = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  /** The SUCCESSOR task (the one that depends on the predecessor). */
  successorTaskId: z.string().min(1),
  /** The PREDECESSOR task (the dependency target). */
  predecessorTaskId: z.string().min(1),
  type: z.enum(['FS', 'SS', 'FF', 'SF']).optional(),
  lag: z.number().int().optional(),
  idempotencyKey: z.string().min(1).max(256),
});
export type AddDependencyInput = z.infer<typeof addDependencyInput>;

export const removeDependencyInput = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  successorTaskId: z.string().min(1),
  predecessorTaskId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256),
});
export type RemoveDependencyInput = z.infer<typeof removeDependencyInput>;
