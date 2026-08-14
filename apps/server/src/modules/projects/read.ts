/**
 * Pure task read queries for MCP (spec §10.2).
 *
 * These operate on a loaded {@link GanttlyFile} in memory — no database. The
 * spec notes first-version MCP search is per-project O(n) over the task list,
 * which keeps the query surface simple and dependency-free.
 */
import type { GanttlyFile, Task } from '@ganttly/schema';
import type { SearchTasksInput } from '@ganttly/api-contract';

export interface TaskSummary {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  start: string;
  end: string;
  duration: number;
  progress: number;
  isMilestone: boolean;
}

export interface TaskDetail {
  task: Task;
  parent: TaskSummary | null;
  /** Tasks that directly precede this one (predecessors). */
  predecessors: TaskSummary[];
  /** Direct children of this task. */
  children: TaskSummary[];
}

function toSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    name: task.name,
    parentId: task.parentId,
    order: task.order,
    start: task.start,
    end: task.end,
    duration: task.duration,
    progress: task.progress,
    isMilestone: task.isMilestone,
  };
}

/** Case-insensitive substring match treating null/undefined as empty. */
function contains(haystack: string | undefined | null, needle: string | undefined): boolean {
  if (!needle) return true;
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

/**
 * Search tasks within a project. Cursor is the id of the last task on the
 * previous page (ordered by `order`); `limit` is already defaulted/clamped by
 * the input schema.
 */
export function searchTasksInFile(
  file: GanttlyFile,
  input: Pick<
    SearchTasksInput,
    | 'name'
    | 'note'
    | 'parentTaskId'
    | 'progressMin'
    | 'progressMax'
    | 'startFrom'
    | 'startTo'
    | 'assigneeResourceId'
    | 'limit'
    | 'cursor'
  >,
): { tasks: TaskSummary[]; nextCursor: string | null } {
  const ordered = [...file.tasks].sort((a, b) => a.order - b.order);
  const startIndex = input.cursor ? ordered.findIndex((t) => t.id === input.cursor) + 1 : 0;
  const candidates = ordered.slice(startIndex);

  const filtered: TaskSummary[] = [];
  for (const task of candidates) {
    if (filtered.length >= input.limit) break;
    if (input.parentTaskId !== undefined && task.parentId !== input.parentTaskId) continue;
    if (!contains(task.name, input.name)) continue;
    if (!contains(task.note, input.note)) continue;
    if (input.progressMin !== undefined && task.progress < input.progressMin) continue;
    if (input.progressMax !== undefined && task.progress > input.progressMax) continue;
    if (input.startFrom !== undefined && task.start < input.startFrom) continue;
    if (input.startTo !== undefined && task.start > input.startTo) continue;
    if (
      input.assigneeResourceId !== undefined &&
      !task.assignments.some((a) => a.resourceId === input.assigneeResourceId)
    ) {
      continue;
    }
    filtered.push(toSummary(task));
  }

  const last = filtered[filtered.length - 1];
  // Emit a cursor only when we filled the page AND more tasks remain.
  const nextCursor =
    filtered.length === input.limit && last
      ? ordered.slice(startIndex).length > input.limit
        ? last.id
        : null
      : null;

  return { tasks: filtered, nextCursor };
}

/** Full task detail with parent, predecessors and direct children (spec §10.2). */
export function getTaskDetail(file: GanttlyFile, taskId: string): TaskDetail | null {
  const task = file.tasks.find((t) => t.id === taskId);
  if (!task) return null;

  const parent = task.parentId
    ? (toSummary(file.tasks.find((t) => t.id === task.parentId)!) ?? null)
    : null;

  const predecessors: TaskSummary[] = task.dependencies
    .map((dep) => file.tasks.find((t) => t.id === dep.targetId))
    .filter((t): t is Task => Boolean(t))
    .map(toSummary);

  const children = file.tasks
    .filter((t) => t.parentId === taskId)
    .sort((a, b) => a.order - b.order)
    .map(toSummary);

  return { task, parent, predecessors, children };
}
