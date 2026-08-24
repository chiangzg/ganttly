/**
 * Pure command model — the single source of truth for project mutations.
 *
 * Every task, dependency, resource, constraint, baseline and view-state change
 * flows through {@link applyProjectCommand}. The function is pure: identical
 * `(file, command, context)` always yields a structurally identical result, and
 * the domain never reads the system clock (callers supply `now` / `today`).
 *
 * Web wraps each `ProjectCommand` in a `toUndoable` adapter (snapshot-based
 * invert) so the undo/redo experience is unchanged. The server calls
 * `applyProjectCommand` directly and relies on revision snapshots + optimistic
 * concurrency instead of client-side invert.
 *
 * The `result` discriminated union carries metadata (createdTaskIds /
 * deletedTasks / dependency edges) that the server uses for operation-log
 * summaries and that MCP uses for structured responses. `adjustments` captures
 * implicit side-effects (non-working-day snap, dependency cascade, ancestor
 * rollup) as command output — not post-hoc inference.
 */
import type {
  GanttlyFile,
  Task,
  Dependency,
  ViewState,
  Holiday,
  Resource,
  TaskAssignment,
  TaskConstraints,
  Baseline,
} from '@ganttly/schema';
import { getCalendar } from '@ganttly/calendar-data';
import { resolveCalendar } from './calendar';
import { computeCascadeRollup, recomputeSelfAndAncestors } from './summary';
import {
  cascadeSchedule,
  satisfyConstraint,
  satisfyDependency,
  wouldCreateCycle,
} from './schedule';

const getHolidays = (region: string): Holiday[] => getCalendar(region).holidays;
export { getHolidays };

// ---------------------------------------------------------------------------
// Context & result types
// ---------------------------------------------------------------------------

export interface ApplyProjectCommandContext {
  /** ISO timestamp; supplied by the caller, never read from the system clock. */
  now: string;
  /** `YYYY-MM-DD` in the project timezone's current day. */
  today: string;
  /** ID of the user or system performing the change. */
  actorId: string;
}

export interface Adjustment {
  field: string;
  from: unknown;
  to: unknown;
  /** `'non-working-day-snap' | 'dependency-cascade' | 'ancestor-rollup'` … */
  reason: string;
}

export type CommandResult =
  | { kind: 'create'; createdTaskIds: string[] }
  | { kind: 'delete'; deletedTasks: Task[] }
  | { kind: 'update' }
  | { kind: 'move' }
  | { kind: 'dependency'; added?: Dependency[]; removed?: Dependency[] }
  | { kind: 'resource' }
  | { kind: 'baseline' }
  | { kind: 'viewState' };

export interface ApplyProjectCommandResult<TResult extends CommandResult = CommandResult> {
  file: GanttlyFile;
  result: TResult;
  /** Target + ancestor-rollup + successor-cascade — every task that changed. */
  affectedTaskIds: string[];
  /** Implicit side-effects, directly feedable to MCP §10.3 adjustment reports. */
  adjustments: Adjustment[];
}

// ---------------------------------------------------------------------------
// Command union — 23 variants mirroring the former Web command factories
// ---------------------------------------------------------------------------

export type ProjectCommand =
  | { kind: 'addTask'; task: Task; parentId: string | null; order: number }
  | { kind: 'updateTask'; taskId: string; patch: Partial<Task> }
  | { kind: 'deleteTask'; taskId: string }
  | { kind: 'batchDeleteTasks'; ids: readonly string[] }
  | { kind: 'addDependency'; successorId: string; dependency: Dependency }
  | { kind: 'deleteDependency'; successorId: string; targetId: string }
  | { kind: 'moveTask'; taskId: string; newParentId: string | null; newOrder: number }
  | { kind: 'setViewState'; patch: Partial<ViewState> }
  | { kind: 'swapSiblingOrder'; aId: string; bId: string }
  | { kind: 'pasteTask'; template: Task; anchorId: string }
  | { kind: 'updateTaskWithRollup'; taskId: string; patch: Partial<Task> }
  | { kind: 'updateTaskFromDraft'; before: Task; after: Task }
  | { kind: 'moveTaskWithRollup'; taskId: string; newParentId: string | null; newOrder: number }
  | { kind: 'addResource'; resource: Resource }
  | { kind: 'updateResource'; resourceId: string; patch: Partial<Resource> }
  | { kind: 'deleteResource'; resourceId: string }
  | { kind: 'moveResource'; resourceId: string; toIndex: number }
  | { kind: 'assignResource'; taskId: string; assignment: TaskAssignment }
  | { kind: 'batchAssignResource'; taskIds: readonly string[]; assignment: TaskAssignment }
  | { kind: 'unassignResource'; taskId: string; resourceId: string }
  | { kind: 'updateConstraint'; taskId: string; constraint: TaskConstraints }
  | { kind: 'createBaseline'; baseline: Baseline }
  | { kind: 'renameBaseline'; baselineId: string; name: string }
  | { kind: 'deleteBaseline'; baselineId: string };

// ---------------------------------------------------------------------------
// Shared task-patch helpers (moved verbatim from the former useProjectStore.ts)
// ---------------------------------------------------------------------------

/**
 * Canonicalize task-local overtime whenever any command patches a task. This
 * central path covers direct edits, drag, constraints and dependency cascades.
 * Dates outside the resulting task range are removed, and milestones cannot
 * retain overtime. Returning the implicit overtime patch is important so the
 * caller captures it for undo/redo alongside the explicit date change.
 */
export function normalizeTaskPatch(task: Task, patch: Partial<Task>): Partial<Task> {
  const merged = { ...task, ...patch };
  const candidate = merged.overtimeDates ?? [];
  const overtimeDates = merged.isMilestone
    ? []
    : [...new Set(candidate)].filter((date) => date >= merged.start && date <= merged.end).sort();
  const current = task.overtimeDates ?? [];
  const overtimeChanged =
    overtimeDates.length !== current.length ||
    overtimeDates.some((date, index) => date !== current[index]);

  if (Object.prototype.hasOwnProperty.call(patch, 'overtimeDates') || overtimeChanged) {
    return { ...patch, overtimeDates };
  }
  return patch;
}

/**
 * Apply a patch to a single task in `tasks`, capturing its pre-change values
 * into `captured` (only the keys present in `patch`) so callers can derive
 * `affectedTaskIds` from the map keys. Used by every command that touches task
 * fields.
 */
export function applyPatchAndCapture(
  tasks: Task[],
  id: string,
  patch: Partial<Task>,
  captured: Map<string, Partial<Task>>,
): Task[] {
  return tasks.map((t) => {
    if (t.id !== id) return t;
    const normalizedPatch = normalizeTaskPatch(t, patch);
    const old: Partial<Task> = {};
    for (const key of Object.keys(normalizedPatch) as Array<keyof Task>) {
      (old as Record<string, unknown>)[key] = t[key];
    }
    // Don't overwrite an earlier capture (a task may be patched more than once
    // — e.g. moveTask captures the target's parentId/order, then rollup also
    // wants to capture its start/end). Keep the union of old values.
    const existing = captured.get(id);
    captured.set(id, existing ? { ...old, ...existing } : old);
    return { ...t, ...normalizedPatch };
  });
}

// ---------------------------------------------------------------------------
// Internal sibling-repacking helpers (move commands)
// ---------------------------------------------------------------------------

/** Re-pack siblings under `parentId` to 0..n-1, preserving the existing order. */
function repackSiblingOrders(
  tasks: Task[],
  parentId: string | null,
  captured: Map<string, Partial<Task>>,
): Task[] {
  const siblings = tasks
    .filter((t) => t.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return assignOrders(tasks, siblings, captured);
}

/**
 * Re-pack the destination parent's siblings, inserting `movedId` at
 * `insertIndex` (clamped). The moved task lands at exactly that index.
 */
function repackWithInsertion(
  tasks: Task[],
  movedId: string,
  parentId: string | null,
  insertIndex: number,
  captured: Map<string, Partial<Task>>,
): Task[] {
  const others = tasks
    .filter((t) => t.parentId === parentId && t.id !== movedId)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const clamped = Math.max(0, Math.min(insertIndex, others.length));
  const moved = tasks.find((t) => t.id === movedId)!;
  const ordered = [...others.slice(0, clamped), moved, ...others.slice(clamped)];
  return assignOrders(tasks, ordered, captured);
}

/** Assign sequential 0..n-1 orders to `ordered` (already in final sequence). */
function assignOrders(
  tasks: Task[],
  ordered: Task[],
  captured: Map<string, Partial<Task>>,
): Task[] {
  const newOrderByIndex = new Map<string, number>();
  ordered.forEach((t, i) => newOrderByIndex.set(t.id, i));
  return tasks.map((t) => {
    const newOrder = newOrderByIndex.get(t.id);
    if (newOrder === undefined || newOrder === t.order) return t;
    captureOrder(t, captured);
    return { ...t, order: newOrder };
  });
}

/** Record a task's pre-change order, merged into any existing capture entry. */
function captureOrder(task: Task, captured: Map<string, Partial<Task>>): void {
  const existing = captured.get(task.id);
  if (existing) {
    if (!('order' in existing)) captured.set(task.id, { ...existing, order: task.order });
  } else {
    captured.set(task.id, { order: task.order });
  }
}

// ---------------------------------------------------------------------------
// Internal draft-merge helpers (updateTaskFromDraft)
// ---------------------------------------------------------------------------

const TASK_DRAFT_FIELDS: Array<keyof Task> = [
  'name',
  'start',
  'end',
  'duration',
  'progress',
  'isMilestone',
  'color',
  'note',
  'overtimeDates',
  'dependencies',
  'constraints',
  'assignments',
];

function mergeTaskDraft(existing: Task, before: Task, after: Task): Task {
  const merged = { ...existing };
  const mergedRecord = merged as unknown as Record<string, unknown>;
  const afterRecord = after as unknown as Record<string, unknown>;

  for (const key of TASK_DRAFT_FIELDS) {
    if (taskDraftFieldEqual(key, before, after)) continue;
    if (Object.prototype.hasOwnProperty.call(after, key)) {
      mergedRecord[key] = afterRecord[key];
    } else {
      delete mergedRecord[key];
    }
  }
  return merged;
}

function taskDraftFieldEqual(key: keyof Task, a: Task, b: Task): boolean {
  return (
    JSON.stringify(normalizeTaskDraftField(key, a)) ===
    JSON.stringify(normalizeTaskDraftField(key, b))
  );
}

function normalizeTaskDraftField(key: keyof Task, task: Task): unknown {
  if (key === 'overtimeDates') return task.overtimeDates ?? [];
  if (key === 'constraints') {
    return { ...task.constraints, type: task.constraints.type ?? ('none' as const) };
  }
  return task[key];
}

function tasksEqualForCommit(a: Task, b: Task): boolean {
  return TASK_DRAFT_FIELDS.every((key) => taskDraftFieldEqual(key, a, b));
}

// ---------------------------------------------------------------------------
// Per-command pure apply functions
// ---------------------------------------------------------------------------

function ok<TResult extends CommandResult>(
  file: GanttlyFile,
  result: TResult,
  affectedTaskIds: string[] = [],
  adjustments: Adjustment[] = [],
): ApplyProjectCommandResult<TResult> {
  return { file, result, affectedTaskIds, adjustments };
}

function resolveCal(file: GanttlyFile) {
  return resolveCalendar(getCalendar(file.calendar.id));
}

// --- Task commands ---------------------------------------------------------

function applyAddTask(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'addTask' }>,
): ApplyProjectCommandResult {
  const newTask: Task = { ...cmd.task, parentId: cmd.parentId, order: cmd.order };
  return ok(
    { ...file, tasks: [...file.tasks, newTask] },
    { kind: 'create', createdTaskIds: [cmd.task.id] },
    [cmd.task.id],
  );
}

function applyUpdateTask(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'updateTask' }>,
): ApplyProjectCommandResult {
  const captured = new Map<string, Partial<Task>>();
  const tasks = applyPatchAndCapture(file.tasks, cmd.taskId, cmd.patch, captured);
  return ok({ ...file, tasks }, { kind: 'update' }, [...captured.keys()]);
}

function applyDeleteTask(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'deleteTask' }>,
): ApplyProjectCommandResult {
  const idsToDelete = deleteClosure(file.tasks, [cmd.taskId]);
  return finishDelete(file, idsToDelete);
}

function applyBatchDeleteTasks(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'batchDeleteTasks' }>,
): ApplyProjectCommandResult {
  const idsToDelete = deleteClosure(file.tasks, cmd.ids);
  return finishDelete(file, idsToDelete);
}

/** Compute the transitive closure of task ids to delete (cascade children). */
function deleteClosure(tasks: Task[], seedIds: ReadonlyArray<string>): Set<string> {
  const idsToDelete = new Set<string>(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (t.parentId && idsToDelete.has(t.parentId) && !idsToDelete.has(t.id)) {
        idsToDelete.add(t.id);
        changed = true;
      }
    }
  }
  return idsToDelete;
}

/** Shared tail for single + batch delete: remove tasks, trim survivor deps. */
function finishDelete(file: GanttlyFile, idsToDelete: Set<string>): ApplyProjectCommandResult {
  const deletedTasks = file.tasks.filter((t) => idsToDelete.has(t.id));
  const affected = new Set<string>();
  const tasksAfterDelete = file.tasks
    .filter((t) => !idsToDelete.has(t.id))
    .map((t) => {
      const affectedRow = t.dependencies.some((dependency) => idsToDelete.has(dependency.targetId));
      if (!affectedRow) return t;
      affected.add(t.id);
      return {
        ...t,
        dependencies: t.dependencies.filter((dependency) => !idsToDelete.has(dependency.targetId)),
      };
    });
  return ok({ ...file, tasks: tasksAfterDelete }, { kind: 'delete', deletedTasks }, [
    ...idsToDelete,
    ...affected,
  ]);
}

// --- Dependency commands ---------------------------------------------------

function applyAddDependency(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'addDependency' }>,
): ApplyProjectCommandResult {
  const captured = new Map<string, Partial<Task>>();
  const { successorId, dependency: dep } = cmd;

  // Defensive guards: the server's command endpoint accepts arbitrary command
  // payloads, so a stale/malformed edge must not crash (missing successor) or
  // persist a corrupt graph (cycle, including a self-loop). Return a no-op
  // result in both cases — consistent with the other missing-task commands.
  const successorTask = file.tasks.find((t) => t.id === successorId);
  if (!successorTask) return ok(file, { kind: 'dependency', added: [] });
  if (wouldCreateCycle(file.tasks, { successorId, predecessorId: dep.targetId })) {
    return ok(file, { kind: 'dependency', added: [] });
  }

  // 1. Add the dependency edge.
  let tasks = applyPatchAndCapture(
    file.tasks,
    successorId,
    {
      dependencies: [...successorTask.dependencies.filter((d) => d.targetId !== dep.targetId), dep],
    },
    captured,
  );

  // 2. The successor ITSELF may now violate the new dependency (unlike a drag,
  // where the moved task's dates are already set). Reschedule the successor
  // against the new predecessor first, then cascade downstream.
  const cal = resolveCal(file);
  const successor = tasks.find((t) => t.id === successorId);
  const predecessor = tasks.find((t) => t.id === dep.targetId);
  if (successor && predecessor) {
    const result = satisfyDependency(predecessor, successor, dep, cal);
    if (result.start && result.start !== successor.start) {
      tasks = applyPatchAndCapture(
        tasks,
        successorId,
        { start: result.start, end: result.end },
        captured,
      );
    }
  }

  // 3. Cascade downstream from the successor (its own move may push its
  // successors). G16: full graph pass on commit.
  const cascadePatches = cascadeSchedule(tasks, successorId, cal);
  for (const cp of cascadePatches) {
    tasks = applyPatchAndCapture(tasks, cp.id, cp.patch, captured);
  }

  return ok({ ...file, tasks }, { kind: 'dependency', added: [dep] }, [...captured.keys()]);
}

function applyDeleteDependency(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'deleteDependency' }>,
): ApplyProjectCommandResult {
  const { successorId, targetId } = cmd;
  const successor = file.tasks.find((t) => t.id === successorId);
  const removedDep = successor?.dependencies.find((d) => d.targetId === targetId);
  return ok(
    {
      ...file,
      tasks: file.tasks.map((t) =>
        t.id === successorId
          ? { ...t, dependencies: t.dependencies.filter((d) => d.targetId !== targetId) }
          : t,
      ),
    },
    { kind: 'dependency', removed: removedDep ? [removedDep] : [] },
    successorId ? [successorId] : [],
  );
}

// --- Move commands ---------------------------------------------------------

function applyMoveTask(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'moveTask' }>,
): ApplyProjectCommandResult {
  const { taskId, newParentId, newOrder } = cmd;
  const target = file.tasks.find((t) => t.id === taskId);
  if (!target) return ok(file, { kind: 'move' });
  return ok(
    {
      ...file,
      tasks: file.tasks.map((t) =>
        t.id === taskId ? { ...t, parentId: newParentId, order: newOrder } : t,
      ),
    },
    { kind: 'move' },
    [taskId],
  );
}

function applySwapSiblingOrder(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'swapSiblingOrder' }>,
): ApplyProjectCommandResult {
  const { aId, bId } = cmd;
  const a = file.tasks.find((t) => t.id === aId);
  const b = file.tasks.find((t) => t.id === bId);
  if (!a || !b) return ok(file, { kind: 'move' });
  const aOrder = a.order;
  const bOrder = b.order;
  return ok(
    {
      ...file,
      tasks: file.tasks.map((t) => {
        if (t.id === aId) return { ...t, order: bOrder };
        if (t.id === bId) return { ...t, order: aOrder };
        return t;
      }),
    },
    { kind: 'move' },
    [aId, bId],
  );
}

function applyPasteTask(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'pasteTask' }>,
): ApplyProjectCommandResult {
  const { template, anchorId } = cmd;
  const anchor = file.tasks.find((t) => t.id === anchorId);
  if (!anchor) return ok(file, { kind: 'create', createdTaskIds: [] });
  const pastedParentId = anchor.parentId;
  const pastedOrder = anchor.order + 1;
  const pasted: Task = { ...template, parentId: pastedParentId, order: pastedOrder };
  const captured = new Set<string>();
  // Bump later siblings.
  const tasks = file.tasks.map((t) => {
    if (t.parentId === pastedParentId && t.order >= pastedOrder) {
      captured.add(t.id);
      return { ...t, order: t.order + 1 };
    }
    return t;
  });
  return ok(
    { ...file, tasks: [...tasks, pasted] },
    { kind: 'create', createdTaskIds: [template.id] },
    [template.id, ...captured],
  );
}

// --- Rollup commands -------------------------------------------------------

function applyUpdateTaskWithRollup(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'updateTaskWithRollup' }>,
): ApplyProjectCommandResult {
  const { taskId, patch } = cmd;
  const captured = new Map<string, Partial<Task>>();

  // 1. Apply patch to target task.
  let tasks = applyPatchAndCapture(file.tasks, taskId, patch, captured);

  // 2-3. Compute cascade rollup and apply each ancestor patch.
  const rollupPatches = computeCascadeRollup(tasks, taskId);
  for (const { id, patch: rp } of rollupPatches) {
    tasks = applyPatchAndCapture(tasks, id, rp, captured);
  }

  // 4. Dependency cascade (P1 feature three, E1.2). Only date-affecting edits
  // propagate downstream.
  const touchesDates = Object.keys(patch).some(
    (k) => k === 'start' || k === 'end' || k === 'duration',
  );
  if (touchesDates) {
    const cal = resolveCal(file);
    const cascadePatches = cascadeSchedule(tasks, taskId, cal);
    for (const cp of cascadePatches) {
      tasks = applyPatchAndCapture(tasks, cp.id, cp.patch, captured);
    }
  }

  return ok({ ...file, tasks }, { kind: 'update' }, [...captured.keys()]);
}

function applyUpdateTaskFromDraft(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'updateTaskFromDraft' }>,
): ApplyProjectCommandResult {
  const { before, after } = cmd;
  const captured = new Map<string, Partial<Task>>();
  const existing = file.tasks.find((t) => t.id === before.id);
  if (!existing) return ok(file, { kind: 'update' });
  // No-op when nothing changed (defensive — UI disables Save when clean).
  if (tasksEqualForCommit(before, after)) return ok(file, { kind: 'update' });

  // 1. Capture the live target exactly, then apply only fields the user changed.
  captured.set(before.id, { ...existing });
  const merged = mergeTaskDraft(existing, before, after);
  let tasks = file.tasks.map((t) => (t.id === before.id ? merged : t));

  const dependenciesChanged =
    JSON.stringify(existing.dependencies) !== JSON.stringify(merged.dependencies);
  const constraintsChanged =
    JSON.stringify(existing.constraints) !== JSON.stringify(merged.constraints);
  const datesChanged =
    existing.start !== merged.start ||
    existing.end !== merged.end ||
    existing.duration !== merged.duration;

  // 2. Apply the same dependency -> constraint scheduling layers.
  if (dependenciesChanged || constraintsChanged || datesChanged) {
    const cal = resolveCal(file);
    let target = tasks.find((t) => t.id === before.id)!;

    for (const dependency of target.dependencies) {
      const predecessor = tasks.find((t) => t.id === dependency.targetId);
      if (!predecessor) continue;
      const result = satisfyDependency(predecessor, target, dependency, cal);
      if (result.start || result.end) {
        tasks = applyPatchAndCapture(
          tasks,
          before.id,
          { start: result.start, end: result.end },
          captured,
        );
        target = tasks.find((t) => t.id === before.id)!;
      }
    }

    const constrained = satisfyConstraint(
      target,
      target.constraints,
      cal,
      target.dependencies.length > 0 ? target.start : undefined,
    );
    if (constrained.start !== target.start || constrained.end !== target.end) {
      tasks = applyPatchAndCapture(
        tasks,
        before.id,
        { start: constrained.start, end: constrained.end },
        captured,
      );
    }
  }

  // 3. Cascade rollup to ancestor summary tasks.
  const rollupPatches = computeCascadeRollup(tasks, before.id);
  for (const { id, patch: rp } of rollupPatches) {
    tasks = applyPatchAndCapture(tasks, id, rp, captured);
  }

  // 4. Cascade from the target after its own dependencies and constraint are
  // final, so every downstream successor sees the committed dates.
  if (dependenciesChanged || constraintsChanged || datesChanged) {
    const cal = resolveCal(file);
    const cascadePatches = cascadeSchedule(tasks, before.id, cal);
    for (const cp of cascadePatches) {
      tasks = applyPatchAndCapture(tasks, cp.id, cp.patch, captured);
    }
  }

  return ok({ ...file, tasks }, { kind: 'update' }, [...captured.keys()]);
}

function applyMoveTaskWithRollup(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'moveTaskWithRollup' }>,
): ApplyProjectCommandResult {
  const { taskId, newParentId, newOrder } = cmd;
  const captured = new Map<string, Partial<Task>>();

  const target = file.tasks.find((t) => t.id === taskId);
  if (!target) return ok(file, { kind: 'move' });

  const oldParentId = target.parentId;

  // 1. Capture the target's own move (parentId/order) for undo.
  captured.set(taskId, { parentId: oldParentId, order: target.order });

  // 2. Build the new sibling list for the destination parent.
  let tasks = file.tasks.map((t) => (t.id === taskId ? { ...t, parentId: newParentId } : t));
  tasks = repackWithInsertion(tasks, taskId, newParentId, newOrder, captured);

  // If the task changed parents, the OLD parent's remaining children must also
  // be re-packed.
  if (oldParentId !== newParentId) {
    tasks = repackSiblingOrders(tasks, oldParentId, captured);
  }

  // 3. Recompute old parent (it lost a child) and its ancestors.
  if (oldParentId && oldParentId !== newParentId) {
    const oldPatches = recomputeSelfAndAncestors(tasks, oldParentId);
    for (const { id, patch } of oldPatches) {
      tasks = applyPatchAndCapture(tasks, id, patch, captured);
    }
  }

  // 4. Recompute new parent (it gained a child) and its ancestors.
  if (newParentId && newParentId !== oldParentId) {
    const newPatches = recomputeSelfAndAncestors(tasks, newParentId);
    for (const { id, patch } of newPatches) {
      tasks = applyPatchAndCapture(tasks, id, patch, captured);
    }
  }

  return ok({ ...file, tasks }, { kind: 'move' }, [...captured.keys()]);
}

// --- View state ------------------------------------------------------------

function applySetViewState(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'setViewState' }>,
): ApplyProjectCommandResult {
  return ok({ ...file, viewState: { ...file.viewState, ...cmd.patch } }, { kind: 'viewState' });
}

// --- Constraint ------------------------------------------------------------

function applyUpdateConstraint(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'updateConstraint' }>,
): ApplyProjectCommandResult {
  const { taskId, constraint } = cmd;
  const captured = new Map<string, Partial<Task>>();
  const target = file.tasks.find((t) => t.id === taskId);
  if (!target) return ok(file, { kind: 'update' });

  // 1. Apply the constraint field change.
  let tasks = applyPatchAndCapture(file.tasks, taskId, { constraints: constraint }, captured);

  // 2. If the constraint affects dates, recompute start/end via
  // satisfyConstraint, then cascade to dependents.
  const cal = resolveCal(file);
  const updated = tasks.find((t) => t.id === taskId)!;
  const result = satisfyConstraint(updated, constraint, cal, updated.start);
  if (result.start !== target.start || result.end !== target.end) {
    tasks = applyPatchAndCapture(tasks, taskId, { start: result.start, end: result.end }, captured);
    const cascadePatches = cascadeSchedule(tasks, taskId, cal);
    for (const cp of cascadePatches) {
      tasks = applyPatchAndCapture(tasks, cp.id, cp.patch, captured);
    }
  }

  return ok({ ...file, tasks }, { kind: 'update' }, [...captured.keys()]);
}

// --- Resource commands -----------------------------------------------------

function applyAddResource(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'addResource' }>,
): ApplyProjectCommandResult {
  return ok({ ...file, resources: [...file.resources, cmd.resource] }, { kind: 'resource' });
}

function applyUpdateResource(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'updateResource' }>,
): ApplyProjectCommandResult {
  const existing = file.resources.find((r) => r.id === cmd.resourceId);
  if (!existing) return ok(file, { kind: 'resource' });
  return ok(
    {
      ...file,
      resources: file.resources.map((r) => (r.id === cmd.resourceId ? { ...r, ...cmd.patch } : r)),
    },
    { kind: 'resource' },
  );
}

function applyDeleteResource(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'deleteResource' }>,
): ApplyProjectCommandResult {
  const exists = file.resources.some((r) => r.id === cmd.resourceId);
  if (!exists) return ok(file, { kind: 'resource' });
  const affected = new Set<string>();
  const tasks = file.tasks.map((t) => {
    if (!t.assignments.some((a) => a.resourceId === cmd.resourceId)) return t;
    affected.add(t.id);
    return {
      ...t,
      assignments: t.assignments.filter((a) => a.resourceId !== cmd.resourceId),
    };
  });
  return ok(
    {
      ...file,
      resources: file.resources.filter((r) => r.id !== cmd.resourceId),
      tasks,
    },
    { kind: 'resource' },
    [...affected],
  );
}

function applyMoveResource(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'moveResource' }>,
): ApplyProjectCommandResult {
  const from = file.resources.findIndex((r) => r.id === cmd.resourceId);
  if (from === -1) return ok(file, { kind: 'resource' });
  const without = file.resources.filter((_, i) => i !== from);
  const to = Math.max(0, Math.min(cmd.toIndex, without.length));
  if (to === from) return ok(file, { kind: 'resource' });
  const next = [...without.slice(0, to), file.resources[from]!, ...without.slice(to)];
  return ok({ ...file, resources: next }, { kind: 'resource' });
}

function applyAssignResource(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'assignResource' }>,
): ApplyProjectCommandResult {
  return ok(
    {
      ...file,
      tasks: file.tasks.map((t) =>
        t.id === cmd.taskId
          ? {
              ...t,
              assignments: [
                ...t.assignments.filter((a) => a.resourceId !== cmd.assignment.resourceId),
                cmd.assignment,
              ],
            }
          : t,
      ),
    },
    { kind: 'resource' },
    [cmd.taskId],
  );
}

function applyBatchAssignResource(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'batchAssignResource' }>,
): ApplyProjectCommandResult {
  // Targets are the selected LEAF tasks — summary tasks are skipped so
  // person-days are never double-counted (mirrors the drawer's G13 block).
  const targets = new Set(cmd.taskIds.filter((id) => !file.tasks.some((t) => t.parentId === id)));
  if (targets.size === 0) return ok(file, { kind: 'resource' });
  const affected = new Set<string>();
  const tasks = file.tasks.map((t) => {
    if (!targets.has(t.id)) return t;
    affected.add(t.id);
    return {
      ...t,
      assignments: [
        ...t.assignments.filter((a) => a.resourceId !== cmd.assignment.resourceId),
        cmd.assignment,
      ],
    };
  });
  return ok({ ...file, tasks }, { kind: 'resource' }, [...affected]);
}

function applyUnassignResource(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'unassignResource' }>,
): ApplyProjectCommandResult {
  const task = file.tasks.find((t) => t.id === cmd.taskId);
  const exists = task?.assignments.some((a) => a.resourceId === cmd.resourceId);
  if (!exists) return ok(file, { kind: 'resource' });
  return ok(
    {
      ...file,
      tasks: file.tasks.map((t) =>
        t.id === cmd.taskId
          ? { ...t, assignments: t.assignments.filter((a) => a.resourceId !== cmd.resourceId) }
          : t,
      ),
    },
    { kind: 'resource' },
    [cmd.taskId],
  );
}

// --- Baseline commands -----------------------------------------------------

function applyCreateBaseline(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'createBaseline' }>,
): ApplyProjectCommandResult {
  return ok({ ...file, baselines: [...file.baselines, cmd.baseline] }, { kind: 'baseline' });
}

function applyRenameBaseline(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'renameBaseline' }>,
): ApplyProjectCommandResult {
  const exists = file.baselines.some((b) => b.id === cmd.baselineId);
  if (!exists) return ok(file, { kind: 'baseline' });
  return ok(
    {
      ...file,
      baselines: file.baselines.map((b) =>
        b.id === cmd.baselineId ? { ...b, name: cmd.name } : b,
      ),
    },
    { kind: 'baseline' },
  );
}

function applyDeleteBaseline(
  file: GanttlyFile,
  cmd: Extract<ProjectCommand, { kind: 'deleteBaseline' }>,
): ApplyProjectCommandResult {
  const exists = file.baselines.some((b) => b.id === cmd.baselineId);
  if (!exists) return ok(file, { kind: 'baseline' });
  return ok(
    {
      ...file,
      baselines: file.baselines.filter((b) => b.id !== cmd.baselineId),
    },
    { kind: 'baseline' },
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Apply a {@link ProjectCommand} to `file` and return the new file plus
 * metadata. Pure, immutable and deterministic — callers supply `now`, `today`
 * and `actorId` via `context` so the domain never reads the system clock.
 */
export function applyProjectCommand(
  file: GanttlyFile,
  command: ProjectCommand,
  _context: ApplyProjectCommandContext,
): ApplyProjectCommandResult {
  switch (command.kind) {
    case 'addTask':
      return applyAddTask(file, command);
    case 'updateTask':
      return applyUpdateTask(file, command);
    case 'deleteTask':
      return applyDeleteTask(file, command);
    case 'batchDeleteTasks':
      return applyBatchDeleteTasks(file, command);
    case 'addDependency':
      return applyAddDependency(file, command);
    case 'deleteDependency':
      return applyDeleteDependency(file, command);
    case 'moveTask':
      return applyMoveTask(file, command);
    case 'setViewState':
      return applySetViewState(file, command);
    case 'swapSiblingOrder':
      return applySwapSiblingOrder(file, command);
    case 'pasteTask':
      return applyPasteTask(file, command);
    case 'updateTaskWithRollup':
      return applyUpdateTaskWithRollup(file, command);
    case 'updateTaskFromDraft':
      return applyUpdateTaskFromDraft(file, command);
    case 'moveTaskWithRollup':
      return applyMoveTaskWithRollup(file, command);
    case 'addResource':
      return applyAddResource(file, command);
    case 'updateResource':
      return applyUpdateResource(file, command);
    case 'deleteResource':
      return applyDeleteResource(file, command);
    case 'moveResource':
      return applyMoveResource(file, command);
    case 'assignResource':
      return applyAssignResource(file, command);
    case 'batchAssignResource':
      return applyBatchAssignResource(file, command);
    case 'unassignResource':
      return applyUnassignResource(file, command);
    case 'updateConstraint':
      return applyUpdateConstraint(file, command);
    case 'createBaseline':
      return applyCreateBaseline(file, command);
    case 'renameBaseline':
      return applyRenameBaseline(file, command);
    case 'deleteBaseline':
      return applyDeleteBaseline(file, command);
  }
}
