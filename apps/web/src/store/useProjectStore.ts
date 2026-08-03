/**
 * Project store — holds the current `GanttlyFile` and exposes mutation
 * actions that wrap the data in `Command` objects (so undo/redo can replay
 * them). The store is the single source of truth for project data.
 *
 * PRD §5.4: three stores — projectStore (data), viewStore (UI), historyStore
 * (undo/redo). This file implements projectStore + historyStore together
 * since they're tightly coupled via the Command pattern.
 */
import { create } from 'zustand';
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
import { createEmptyFile, normalizeFile } from '@ganttly/schema';
import { getCalendar } from '@ganttly/calendar-data';
import {
  DEFAULT_PROJECT_ID,
  type ProjectId,
  type ProjectRepository,
  type ProjectRevision,
} from '@/data/repository';
import { computeCascadeRollup, recomputeSelfAndAncestors } from '@/lib/summary';
import {
  cascadeSchedule,
  satisfyConstraint,
  satisfyDependency,
  countDependencyViolations,
} from '@/lib/schedule';
import { resolveCalendar } from '@/lib/calendar';

/** Holiday provider injected into normalizeFile (keeps schema pkg dependency-free). */
const getHolidays = (region: string): Holiday[] => getCalendar(region).holidays;

// ---------------------------------------------------------------------------
// Command pattern (PRD §3.7)
// ---------------------------------------------------------------------------

export interface Command<T = GanttlyFile> {
  /** Human-readable label, e.g. "删除任务: 设计评审". */
  readonly label: string;
  /** Apply forward mutation (mutates a draft). */
  apply(state: T): T;
  /** Apply reverse mutation. */
  invert(state: T): T;
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface SaveState {
  status: 'idle' | 'saving' | 'saved' | 'error';
  error?: string;
}

interface ProjectStoreState {
  file: GanttlyFile;
  repo: ProjectRepository | null;
  activeProjectId: ProjectId | null;
  revision: ProjectRevision | null;
  dirty: boolean;
  loadState: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  saveState: SaveState;

  // Lifecycle
  setRepository(repo: ProjectRepository): void;
  init(repo: ProjectRepository): Promise<void>;
  loadProject(id: ProjectId): Promise<boolean>;
  unloadProject(): void;
  flushPendingSave(): Promise<void>;
  setFile(file: GanttlyFile): void;

  // Command dispatch (also pushes onto undo stack)
  dispatch(command: Command): void;

  // History
  undoStack: Command[];
  redoStack: Command[];
  undo(): void;
  /** Undo `command` only while it is still the latest history entry. */
  undoCommand(command: Command): boolean;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  nextUndoLabel(): string | null;
  nextRedoLabel(): string | null;

  // Persistence (debounced; called automatically after dispatch)
  save(): Promise<void>;
  lastSaveError: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a file on load/import — backfills missing optional fields (zh-CN
 * holidays for older exports, future P1 field defaults). Delegates to
 * `normalizeFile` so all three load paths (JSON import, .gan import, IndexedDB
 * load) share a single normalization point (Q10). Thin wrapper kept so call
 * sites read naturally.
 */
function withCalendar(file: GanttlyFile): GanttlyFile {
  return normalizeFile(file, { getHolidays });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loadGeneration = 0;
let savePromise: Promise<void> | null = null;

function clearSaveTimer(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

function scheduleSave(projectId: ProjectId | null): void {
  clearSaveTimer();
  if (!projectId) return;
  saveTimer = setTimeout(() => {
    const state = useProjectStore.getState();
    if (state.activeProjectId === projectId) void state.save();
  }, 500);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  file: withCalendar(createEmptyFile()),
  repo: null,
  activeProjectId: null,
  revision: null,
  dirty: false,
  loadState: 'idle',
  saveState: { status: 'idle' },
  undoStack: [],
  redoStack: [],
  lastSaveError: null,

  setRepository(repo) {
    set({ repo });
  },

  async init(repo) {
    ++loadGeneration;
    clearSaveTimer();
    set({
      repo,
      activeProjectId: null,
      revision: null,
      dirty: false,
      loadState: 'idle',
      undoStack: [],
      redoStack: [],
    });
    let snapshot = await repo.loadProject(DEFAULT_PROJECT_ID);
    if (!snapshot) {
      snapshot = await repo.createProject({
        id: DEFAULT_PROJECT_ID,
        file: withCalendar(createEmptyFile({ name: '我的项目' })),
      });
    }
    await get().loadProject(snapshot.summary.id);
  },

  async loadProject(id) {
    const { repo, activeProjectId, dirty } = get();
    if (!repo) return false;
    if (activeProjectId === id && get().loadState === 'ready') return true;
    if (activeProjectId && dirty) await get().flushPendingSave();

    const generation = ++loadGeneration;
    clearSaveTimer();
    set({ loadState: 'loading', lastSaveError: null });
    try {
      const snapshot = await repo.loadProject(id);
      if (generation !== loadGeneration) return false;
      if (!snapshot || snapshot.summary.deletedAt) {
        set({ loadState: 'missing' });
        return false;
      }
      const normalized = withCalendar(snapshot.file);
      set({
        activeProjectId: id,
        revision: snapshot.revision,
        file: normalized,
        dirty: false,
        loadState: 'ready',
        saveState: { status: 'saved' },
        undoStack: [],
        redoStack: [],
      });
      scheduleViolationCheck(normalized, get);
      return true;
    } catch (error) {
      if (generation === loadGeneration) {
        const message = (error as Error).message;
        set({ loadState: 'error', lastSaveError: message });
      }
      return false;
    }
  },

  unloadProject() {
    ++loadGeneration;
    clearSaveTimer();
    set({
      activeProjectId: null,
      revision: null,
      dirty: false,
      loadState: 'idle',
      undoStack: [],
      redoStack: [],
      saveState: { status: 'idle' },
    });
  },

  async flushPendingSave() {
    clearSaveTimer();
    if (savePromise) await savePromise;
    if (get().dirty) await get().save();
    const state = get();
    if (state.saveState.status === 'error') {
      throw new Error(state.lastSaveError ?? 'Project save failed');
    }
  },

  setFile(file) {
    set({ file, dirty: true, saveState: { status: 'saving' } });
    scheduleSave(get().activeProjectId);
  },

  dispatch(command) {
    const { file } = get();
    const next = command.apply(file);
    set({
      file: next,
      undoStack: [...get().undoStack, command],
      redoStack: [], // any new action clears redo
      dirty: true,
      saveState: { status: 'saving' },
    });
    scheduleSave(get().activeProjectId);
  },

  undo() {
    const { undoStack, redoStack, file } = get();
    if (undoStack.length === 0) return;
    const command = undoStack[undoStack.length - 1]!;
    const reverted = command.invert(file);
    set({
      file: reverted,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, command],
      dirty: true,
      saveState: { status: 'saving' },
    });
    scheduleSave(get().activeProjectId);
  },

  undoCommand(command) {
    const latest = get().undoStack.at(-1);
    if (latest !== command) return false;
    get().undo();
    return true;
  },

  redo() {
    const { undoStack, redoStack, file } = get();
    if (redoStack.length === 0) return;
    const command = redoStack[redoStack.length - 1]!;
    const applied = command.apply(file);
    set({
      file: applied,
      undoStack: [...undoStack, command],
      redoStack: redoStack.slice(0, -1),
      dirty: true,
      saveState: { status: 'saving' },
    });
    scheduleSave(get().activeProjectId);
  },

  canUndo() {
    return get().undoStack.length > 0;
  },

  canRedo() {
    return get().redoStack.length > 0;
  },

  nextUndoLabel() {
    const stack = get().undoStack;
    return stack.length === 0 ? null : stack[stack.length - 1]!.label;
  },

  nextRedoLabel() {
    const stack = get().redoStack;
    return stack.length === 0 ? null : stack[stack.length - 1]!.label;
  },

  async save() {
    if (savePromise) {
      await savePromise;
      if (get().dirty) await get().save();
      return;
    }
    savePromise = performSave(get, set);
    try {
      await savePromise;
    } finally {
      savePromise = null;
    }
  },
}));

async function performSave(
  get: () => ProjectStoreState,
  set: (partial: Partial<ProjectStoreState>) => void,
): Promise<void> {
  const { repo, file, activeProjectId, revision } = get();
  if (!repo || !activeProjectId || revision === null) return;
  clearSaveTimer();
  set({ saveState: { status: 'saving' } });
  try {
    const stamped: GanttlyFile = {
      ...file,
      meta: { ...file.meta, updatedAt: new Date().toISOString() },
    };
    const snapshot = await repo.saveProject(activeProjectId, stamped, {
      expectedRevision: revision,
    });
    const current = get();
    if (current.activeProjectId !== activeProjectId) return;
    const changedWhileSaving = current.file !== file;
    set({
      file: changedWhileSaving ? current.file : snapshot.file,
      revision: snapshot.revision,
      dirty: changedWhileSaving,
      saveState: { status: changedWhileSaving ? 'saving' : 'saved' },
      lastSaveError: null,
    });
    if (changedWhileSaving) scheduleSave(activeProjectId);
  } catch (err) {
    const msg = (err as Error).message;
    set({ saveState: { status: 'error', error: msg }, lastSaveError: msg });
  }
}

function scheduleViolationCheck(normalized: GanttlyFile, get: () => ProjectStoreState): void {
  const cal = resolveCalendar(getCalendar(normalized.calendar.id));
  const violations = countDependencyViolations(normalized.tasks, cal);
  if (violations === 0) return;
  setTimeout(() => {
    const msg = `检测到 ${violations} 处依赖违反（后继任务日期早于前置任务暗示值），是否自动顺移？`;
    if (typeof window === 'undefined' || !window.confirm(msg)) return;
    const current = get().file;
    let tasks = current.tasks;
    const captured = new Map<string, Partial<Task>>();
    for (const task of current.tasks) {
      const patches = cascadeSchedule(tasks, task.id, cal);
      for (const patch of patches) {
        tasks = applyPatchAndCapture(tasks, patch.id, patch.patch, captured);
      }
    }
    if (captured.size > 0) get().setFile({ ...current, tasks });
  }, 100);
}

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

export function addTaskCommand(task: Task, parentId: string | null, order: number): Command {
  const newTask: Task = { ...task, parentId, order };
  return {
    label: `新增任务: ${task.name}`,
    apply: (file) => ({
      ...file,
      tasks: [...file.tasks, newTask],
    }),
    invert: (file) => ({
      ...file,
      tasks: file.tasks.filter((t) => t.id !== newTask.id),
    }),
  };
}

export function updateTaskCommand(taskId: string, patch: Partial<Task>): Command {
  let oldFields: Partial<Task> | null = null;
  return {
    label: `更新任务`,
    apply: (file) => {
      const existing = file.tasks.find((t) => t.id === taskId);
      if (!existing) return file;
      const normalizedPatch = normalizeTaskPatch(existing, patch);
      // Capture the original values of every key we're about to overwrite.
      oldFields = {};
      for (const key of Object.keys(normalizedPatch) as Array<keyof Task>) {
        (oldFields as Record<string, unknown>)[key] = existing[key];
      }
      return {
        ...file,
        tasks: file.tasks.map((t) => (t.id === taskId ? { ...t, ...normalizedPatch } : t)),
      };
    },
    invert: (file) => {
      if (!oldFields) return file;
      const restore = oldFields;
      return {
        ...file,
        tasks: file.tasks.map((t) => (t.id === taskId ? { ...t, ...restore } : t)),
      };
    },
  };
}

export function deleteTaskCommand(taskId: string): Command {
  // Captured at apply time: every deleted task and their dependencies (for
  // dependency arrows that reference them). The undo toast (editor-interaction
  // plan §2.4) must restore the full tree, so best-effort invert is insufficient.
  let capturedDeletedTasks: Task[] | null = null;
  let capturedSurvivorDependencies: Map<string, Dependency[]> | null = null;
  return {
    label: `删除任务`,
    apply: (file) => {
      const idsToDelete = new Set<string>([taskId]);
      // Cascade delete descendants.
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of file.tasks) {
          if (t.parentId && idsToDelete.has(t.parentId) && !idsToDelete.has(t.id)) {
            idsToDelete.add(t.id);
            changed = true;
          }
        }
      }
      capturedDeletedTasks = file.tasks.filter((t) => idsToDelete.has(t.id));
      capturedSurvivorDependencies = new Map();
      // Also remove dependency edges pointing to any deleted task.
      const tasksAfterDelete = file.tasks
        .filter((t) => !idsToDelete.has(t.id))
        .map((t) => {
          const affected = t.dependencies.some((dependency) =>
            idsToDelete.has(dependency.targetId),
          );
          if (!affected) return t;
          capturedSurvivorDependencies!.set(t.id, t.dependencies);
          return {
            ...t,
            dependencies: t.dependencies.filter(
              (dependency) => !idsToDelete.has(dependency.targetId),
            ),
          };
        });
      return { ...file, tasks: tasksAfterDelete };
    },
    invert: (file) => {
      if (!capturedDeletedTasks || !capturedSurvivorDependencies) return file;
      const survivingTasks = file.tasks.map((task) => {
        const dependencies = capturedSurvivorDependencies!.get(task.id);
        return dependencies ? { ...task, dependencies } : task;
      });
      return {
        ...file,
        tasks: [...survivingTasks, ...capturedDeletedTasks],
      };
    },
  };
}

/**
 * Batch-delete multiple tasks as ONE command (plan §4.6: "批量修改必须封装为
 * 单个复合 command"). Generalises {@link deleteTaskCommand}: the initial set
 * is closed transitively under `parentId` (deleting a parent removes its
 * children), so selecting both a parent and its child deletes the subtree once
 * rather than twice (plan §4.6 验收 "删除父子任务同时被选中时避免重复计数和
 * 重复删除"). A single undo restores every deleted task and every trimmed
 * dependency edge.
 */
export function batchDeleteTasksCommand(ids: ReadonlyArray<string>): Command {
  let capturedDeletedTasks: Task[] | null = null;
  let capturedSurvivorDependencies: Map<string, Dependency[]> | null = null;
  return {
    label: `批量删除任务`,
    apply: (file) => {
      const idsToDelete = new Set<string>(ids);
      // Cascade-delete descendants of every selected task (same closure as
      // deleteTaskCommand, just seeded with multiple roots).
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of file.tasks) {
          if (t.parentId && idsToDelete.has(t.parentId) && !idsToDelete.has(t.id)) {
            idsToDelete.add(t.id);
            changed = true;
          }
        }
      }
      capturedDeletedTasks = file.tasks.filter((t) => idsToDelete.has(t.id));
      capturedSurvivorDependencies = new Map();
      const tasksAfterDelete = file.tasks
        .filter((t) => !idsToDelete.has(t.id))
        .map((t) => {
          const affected = t.dependencies.some((dependency) =>
            idsToDelete.has(dependency.targetId),
          );
          if (!affected) return t;
          capturedSurvivorDependencies!.set(t.id, t.dependencies);
          return {
            ...t,
            dependencies: t.dependencies.filter(
              (dependency) => !idsToDelete.has(dependency.targetId),
            ),
          };
        });
      return { ...file, tasks: tasksAfterDelete };
    },
    invert: (file) => {
      if (!capturedDeletedTasks || !capturedSurvivorDependencies) return file;
      const survivingTasks = file.tasks.map((task) => {
        const dependencies = capturedSurvivorDependencies!.get(task.id);
        return dependencies ? { ...task, dependencies } : task;
      });
      return {
        ...file,
        tasks: [...survivingTasks, ...capturedDeletedTasks],
      };
    },
  };
}

export function addDependencyCommand(successorId: string, dep: Dependency): Command {
  // Captured at apply time: the successor's dependency list (for the structural
  // change) PLUS every task whose start/end moved due to the cascade.
  let capturedOldValues: Map<string, Partial<Task>> | null = null;
  return {
    label: `新增依赖`,
    apply: (file) => {
      capturedOldValues = new Map();

      // 1. Add the dependency edge (capture the old dependencies for undo).
      let tasks = applyPatchAndCapture(
        file.tasks,
        successorId,
        {
          dependencies: [
            ...file.tasks
              .find((t) => t.id === successorId)!
              .dependencies.filter((d) => d.targetId !== dep.targetId),
            dep,
          ],
        },
        capturedOldValues,
      );

      // 2. The successor ITSELF may now violate the new dependency (unlike a
      // drag, where the moved task's dates are already set). Reschedule the
      // successor against the new predecessor first, then cascade downstream.
      const cal = resolveCalendar(getCalendar(file.calendar.id));
      const successor = tasks.find((t) => t.id === successorId);
      const predecessor = tasks.find((t) => t.id === dep.targetId);
      if (successor && predecessor) {
        const result = satisfyDependency(predecessor, successor, dep, cal);
        if (result.start && result.start !== successor.start) {
          tasks = applyPatchAndCapture(
            tasks,
            successorId,
            { start: result.start, end: result.end },
            capturedOldValues,
          );
        }
      }

      // 3. Cascade downstream from the successor (its own move may push its
      // successors). G16: full graph pass on commit.
      const cascadePatches = cascadeSchedule(tasks, successorId, cal);
      for (const cp of cascadePatches) {
        tasks = applyPatchAndCapture(tasks, cp.id, cp.patch, capturedOldValues);
      }

      return { ...file, tasks };
    },
    invert: (file) => {
      if (!capturedOldValues) return file;
      return { ...file, tasks: restoreCaptured(file.tasks, capturedOldValues) };
    },
  };
}

export function deleteDependencyCommand(successorId: string, targetId: string): Command {
  return {
    label: `删除依赖`,
    apply: (file) => ({
      ...file,
      tasks: file.tasks.map((t) =>
        t.id === successorId
          ? { ...t, dependencies: t.dependencies.filter((d) => d.targetId !== targetId) }
          : t,
      ),
    }),
    invert: (file) => file, // best-effort
  };
}

export function moveTaskCommand(
  taskId: string,
  newParentId: string | null,
  newOrder: number,
): Command {
  let oldParent: string | null = null;
  let oldOrder = 0;
  return {
    label: `移动任务`,
    apply: (file) => {
      const target = file.tasks.find((t) => t.id === taskId);
      if (!target) return file;
      oldParent = target.parentId;
      oldOrder = target.order;
      return {
        ...file,
        tasks: file.tasks.map((t) =>
          t.id === taskId ? { ...t, parentId: newParentId, order: newOrder } : t,
        ),
      };
    },
    invert: (file) => ({
      ...file,
      tasks: file.tasks.map((t) =>
        t.id === taskId ? { ...t, parentId: oldParent, order: oldOrder } : t,
      ),
    }),
  };
}

export function setViewStateCommand(patch: Partial<ViewState>): Command {
  let oldViewState: ViewState | null = null;
  return {
    label: `视图变更`,
    apply: (file) => {
      oldViewState = file.viewState;
      return { ...file, viewState: { ...file.viewState, ...patch } };
    },
    invert: (file) => ({ ...file, viewState: oldViewState ?? file.viewState }),
  };
}

/**
 * Swap the `order` of two sibling tasks (PRD §3.10 Alt+Up/Down). Both ids must
 * share the same parentId. Captures each task's prior order so undo restores.
 */
export function swapSiblingOrderCommand(aId: string, bId: string): Command {
  let oldAOrder = 0;
  let oldBOrder = 0;
  return {
    label: `调整顺序`,
    apply: (file) => {
      const a = file.tasks.find((t) => t.id === aId);
      const b = file.tasks.find((t) => t.id === bId);
      if (!a || !b) return file;
      oldAOrder = a.order;
      oldBOrder = b.order;
      return {
        ...file,
        tasks: file.tasks.map((t) => {
          if (t.id === aId) return { ...t, order: oldBOrder };
          if (t.id === bId) return { ...t, order: oldAOrder };
          return t;
        }),
      };
    },
    invert: (file) => ({
      ...file,
      tasks: file.tasks.map((t) => {
        if (t.id === aId) return { ...t, order: oldAOrder };
        if (t.id === bId) return { ...t, order: oldBOrder };
        return t;
      }),
    }),
  };
}

/**
 * Insert a copy of `template` as the next sibling of `anchorId`, bumping the
 * order of all later siblings. Used by paste (PRD §3.10 Ctrl+V). The template
 * already has a fresh id assigned by the caller.
 */
export function pasteTaskCommand(template: Task, anchorId: string): Command {
  let pastedParentId: string | null = null;
  let pastedOrder = 0;
  return {
    label: `粘贴任务`,
    apply: (file) => {
      const anchor = file.tasks.find((t) => t.id === anchorId);
      if (!anchor) return file;
      pastedParentId = anchor.parentId;
      pastedOrder = anchor.order + 1;
      const pasted: Task = { ...template, parentId: pastedParentId, order: pastedOrder };
      // Bump later siblings.
      const tasks = file.tasks.map((t) =>
        t.parentId === pastedParentId && t.order >= pastedOrder ? { ...t, order: t.order + 1 } : t,
      );
      return { ...file, tasks: [...tasks, pasted] };
    },
    invert: (file) => {
      // Remove the pasted task and shift back the siblings we bumped.
      const tasks = file.tasks
        .filter((t) => t.id !== template.id)
        .map((t) =>
          t.parentId === pastedParentId && t.order > pastedOrder ? { ...t, order: t.order - 1 } : t,
        );
      return { ...file, tasks };
    },
  };
}

/**
 * Apply a patch to a single task in `tasks`, capturing its pre-change values
 * into `captured` (only the keys present in `patch`) so the command's `invert`
 * can restore them later. Used by the rollup commands below.
 */
function applyPatchAndCapture(
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

/**
 * Canonicalize task-local overtime whenever any command patches a task. This
 * central path covers direct edits, drag, constraints and dependency cascades.
 * Dates outside the resulting task range are removed, and milestones cannot
 * retain overtime. Returning the implicit overtime patch is important so the
 * caller captures it for undo/redo alongside the explicit date change.
 */
function normalizeTaskPatch(task: Task, patch: Partial<Task>): Partial<Task> {
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

/** Restore captured old values onto a tasks array (shared `invert` body). */
function restoreCaptured(tasks: Task[], captured: Map<string, Partial<Task>>): Task[] {
  return tasks.map((t) => {
    const old = captured.get(t.id);
    return old ? { ...t, ...old } : t;
  });
}

/**
 * Update a task and cascade rollup to all ancestors.
 * The apply captures old values for all modified tasks (target + ancestors).
 */
export function updateTaskWithRollupCommand(taskId: string, patch: Partial<Task>): Command {
  let capturedOldValues: Map<string, Partial<Task>> | null = null;
  return {
    label: `更新任务(含汇总)`,
    apply: (file) => {
      capturedOldValues = new Map();

      // 1. Apply patch to target task (captures old values for the patch keys)
      let tasks = applyPatchAndCapture(file.tasks, taskId, patch, capturedOldValues);

      // 2-3. Compute cascade rollup and apply each ancestor patch.
      // `taskId` itself is not recomputed here (it's the edit target).
      const rollupPatches = computeCascadeRollup(tasks, taskId);
      for (const { id, patch: rp } of rollupPatches) {
        tasks = applyPatchAndCapture(tasks, id, rp, capturedOldValues);
      }

      // 4. Dependency cascade (P1 feature three, E1.2). Only date-affecting
      // edits propagate downstream — moving a task reschedules its successors.
      // Non-date edits (name, progress) skip this (no successor impact).
      const touchesDates = Object.keys(patch).some(
        (k) => k === 'start' || k === 'end' || k === 'duration',
      );
      if (touchesDates) {
        const cal = resolveCalendar(getCalendar(file.calendar.id));
        const cascadePatches = cascadeSchedule(tasks, taskId, cal);
        for (const cp of cascadePatches) {
          tasks = applyPatchAndCapture(tasks, cp.id, cp.patch, capturedOldValues);
        }
      }

      return { ...file, tasks };
    },
    invert: (file) => {
      if (!capturedOldValues) return file;
      return { ...file, tasks: restoreCaptured(file.tasks, capturedOldValues) };
    },
  };
}

/**
 * Commit a full task-draft edit as ONE undoable command (editor-interaction-
 * optimization-plan §2.2 / §6.5).
 *
 * The TaskDrawer now keeps a complete draft (base fields + assignments +
 * dependencies + constraints) and only commits on explicit "Save". This
 * command three-way merges the fields changed between `before` and `after`
 * onto the live task, then re-runs the same rollup + dependency cascade that a
 * live date edit would. This preserves canvas edits made while the docked
 * drawer is open while keeping one save as one undoable command.
 *
 * `before` is the task snapshot captured when the drawer opened. Undo captures
 * the live task at apply time, so it restores the state immediately before the
 * save even when the live file diverged while the drawer was open.
 *
 * When `after` is identical to `before`, `apply` is a no-op and returns the
 * file unchanged (the drawer disables Save in that case, but this is the
 * safety net).
 *
 * Why a dedicated command (instead of dispatching updateTask +
 * assignResource + addDependency …): the plan §6.5 explicitly forbids
 * "simulating one save via several consecutive commands" because that yields
 * N undo records and breaks the "one save = one undo" contract.
 */
export function updateTaskFromDraftCommand(before: Task, after: Task): Command {
  let capturedOldValues: Map<string, Partial<Task>> | null = null;
  let capturedTarget: Task | null = null;
  return {
    label: `保存任务: ${after.name || before.name}`,
    apply: (file) => {
      capturedOldValues = new Map();
      const existing = file.tasks.find((t) => t.id === before.id);
      if (!existing) return file;
      // No-op when nothing changed (defensive — UI disables Save when clean).
      if (tasksEqualForCommit(before, after)) return file;

      // 1. Capture the live target exactly, then apply only fields the user
      // changed in the draft. Untouched fields retain concurrent canvas edits.
      capturedTarget = existing;
      capturedOldValues.set(before.id, { ...existing });
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

      // 2. Apply the same dependency -> constraint scheduling layers used by
      // their dedicated commands. This keeps a structural-only draft edit from
      // leaving the task in an immediately invalid schedule.
      if (dependenciesChanged || constraintsChanged || datesChanged) {
        const cal = resolveCalendar(getCalendar(file.calendar.id));
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
              capturedOldValues,
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
            capturedOldValues,
          );
        }
      }

      // 3. Cascade rollup to ancestor summary tasks (start/end/progress).
      const rollupPatches = computeCascadeRollup(tasks, before.id);
      for (const { id, patch: rp } of rollupPatches) {
        tasks = applyPatchAndCapture(tasks, id, rp, capturedOldValues);
      }

      // 4. Cascade from the target after its own dependencies and constraint
      // are final, so every downstream successor sees the committed dates.
      if (dependenciesChanged || constraintsChanged || datesChanged) {
        const cal = resolveCalendar(getCalendar(file.calendar.id));
        const cascadePatches = cascadeSchedule(tasks, before.id, cal);
        for (const cp of cascadePatches) {
          tasks = applyPatchAndCapture(tasks, cp.id, cp.patch, capturedOldValues);
        }
      }

      return { ...file, tasks };
    },
    invert: (file) => {
      if (!capturedOldValues || !capturedTarget) return file;
      const restored = restoreCaptured(file.tasks, capturedOldValues).map((task) =>
        task.id === capturedTarget!.id ? capturedTarget! : task,
      );
      return { ...file, tasks: restored };
    },
  };
}

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

/**
 * Apply the user's draft delta to the latest live task. Draft changes win on a
 * same-field conflict; fields untouched in the drawer retain their live value.
 */
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

/**
 * Structural equality over the fields a draft save can change. We compare by
 * JSON of a normalised pick rather than reference equality so re-creating a
 * draft object with identical values still counts as "no change".
 *
 * `constraints` and `overtimeDates` are normalised on both sides because the
 * TaskDrawer normalises its draft (legacy `constraints: {}` → `{type:'none'}`,
 * missing `overtimeDates` → `[]`) — without normalising here, opening a task
 * whose stored shape differs only by these defaults would look "changed" and
 * defeat the no-op fast path.
 */
function tasksEqualForCommit(a: Task, b: Task): boolean {
  return TASK_DRAFT_FIELDS.every((key) => taskDraftFieldEqual(key, a, b));
}

/**
 * Move a task and rollup both old and new parent chains.
 *
 * Uses {@link recomputeSelfAndAncestors} so that the old parent (which may have
 * lost a child) and the new parent (which gained one) are themselves
 * recomputed — not just their ancestors.
 */
export function moveTaskWithRollupCommand(
  taskId: string,
  newParentId: string | null,
  newOrder: number,
): Command {
  let capturedOldValues: Map<string, Partial<Task>> | null = null;

  return {
    label: `移动任务(含汇总)`,
    apply: (file) => {
      capturedOldValues = new Map();
      const target = file.tasks.find((t) => t.id === taskId);
      if (!target) return file;

      const oldParentId = target.parentId;

      // 1. Capture the target's own move (parentId/order) for undo.
      capturedOldValues.set(taskId, { parentId: oldParentId, order: target.order });

      // 2. Build the new sibling list for the destination parent: remove the
      //    moved task from wherever it currently sits, then insert it at the
      //    requested index (`newOrder`, clamped to [0, siblingCount]). Repack
      //    to 0..n-1 so there are no duplicate or skipped orders (plan §2.3
      //    step 4). Capture every sibling whose order changes so undo restores
      //    the whole group, not just the target.
      let tasks = file.tasks.map((t) => (t.id === taskId ? { ...t, parentId: newParentId } : t));
      tasks = repackWithInsertion(tasks, taskId, newParentId, newOrder, capturedOldValues);

      // If the task changed parents, the OLD parent's remaining children must
      // also be re-packed (the moved task left a gap).
      if (oldParentId !== newParentId) {
        tasks = repackSiblingOrders(tasks, oldParentId, capturedOldValues);
      }

      // 3. Recompute old parent (it lost a child) and its ancestors.
      if (oldParentId && oldParentId !== newParentId) {
        const oldPatches = recomputeSelfAndAncestors(tasks, oldParentId);
        for (const { id, patch } of oldPatches) {
          tasks = applyPatchAndCapture(tasks, id, patch, capturedOldValues);
        }
      }

      // 4. Recompute new parent (it gained a child) and its ancestors.
      if (newParentId && newParentId !== oldParentId) {
        const newPatches = recomputeSelfAndAncestors(tasks, newParentId);
        for (const { id, patch } of newPatches) {
          tasks = applyPatchAndCapture(tasks, id, patch, capturedOldValues);
        }
      }

      return { ...file, tasks };
    },
    invert: (file) => {
      if (!capturedOldValues) return file;
      return { ...file, tasks: restoreCaptured(file.tasks, capturedOldValues) };
    },
  };
}

/**
 * Re-pack siblings under `parentId` to 0..n-1, preserving the existing order.
 * Captures every changed order. Used for the group the moved task just left.
 */
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
 * `insertIndex` (clamped). The moved task lands at exactly that index; the
 * others shift to make room. Captures every changed order for undo.
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
// Resource commands (P1 feature one)
// ---------------------------------------------------------------------------

export function addResourceCommand(resource: Resource): Command {
  return {
    label: `新增资源: ${resource.name}`,
    apply: (file) => ({ ...file, resources: [...file.resources, resource] }),
    invert: (file) => ({ ...file, resources: file.resources.filter((r) => r.id !== resource.id) }),
  };
}

export function updateResourceCommand(resourceId: string, patch: Partial<Resource>): Command {
  let oldFields: Partial<Resource> | null = null;
  return {
    label: `更新资源`,
    apply: (file) => {
      const existing = file.resources.find((r) => r.id === resourceId);
      if (!existing) return file;
      oldFields = {};
      for (const key of Object.keys(patch) as Array<keyof Resource>) {
        (oldFields as Record<string, unknown>)[key] = existing[key];
      }
      return {
        ...file,
        resources: file.resources.map((r) => (r.id === resourceId ? { ...r, ...patch } : r)),
      };
    },
    invert: (file) => {
      if (!oldFields) return file;
      const restore = oldFields;
      return {
        ...file,
        resources: file.resources.map((r) => (r.id === resourceId ? { ...r, ...restore } : r)),
      };
    },
  };
}

export function deleteResourceCommand(resourceId: string): Command {
  // Captured at apply time: the resource and every assignment, including their
  // original positions, so undo is lossless for ordering and allocation load.
  let captured: {
    resource: Resource;
    resourceIndex: number;
    assignments: Array<{ taskId: string; index: number; assignment: TaskAssignment }>;
  } | null = null;
  return {
    label: `删除资源`,
    apply: (file) => {
      const resourceIndex = file.resources.findIndex((r) => r.id === resourceId);
      if (resourceIndex < 0) return file;
      const resource = file.resources[resourceIndex]!;
      const assignments: Array<{
        taskId: string;
        index: number;
        assignment: TaskAssignment;
      }> = [];
      for (const t of file.tasks) {
        t.assignments.forEach((assignment, index) => {
          if (assignment.resourceId === resourceId) {
            assignments.push({ taskId: t.id, index, assignment: { ...assignment } });
          }
        });
      }
      captured = { resource: { ...resource }, resourceIndex, assignments };
      return {
        ...file,
        resources: file.resources.filter((r) => r.id !== resourceId),
        tasks: file.tasks.map((t) =>
          t.assignments.some((a) => a.resourceId === resourceId)
            ? {
                ...t,
                assignments: t.assignments.filter((a) => a.resourceId !== resourceId),
              }
            : t,
        ),
      };
    },
    invert: (file) => {
      if (!captured) return file;
      const { resource, resourceIndex, assignments } = captured;
      const restoredResources = [...file.resources];
      restoredResources.splice(Math.min(resourceIndex, restoredResources.length), 0, resource);
      const assignmentsByTask = new Map<
        string,
        Array<{ index: number; assignment: TaskAssignment }>
      >();
      for (const { taskId, index, assignment } of assignments) {
        const entries = assignmentsByTask.get(taskId) ?? [];
        entries.push({ index, assignment });
        assignmentsByTask.set(taskId, entries);
      }
      return {
        ...file,
        resources: restoredResources,
        tasks: file.tasks.map((t) => {
          const entries = assignmentsByTask.get(t.id);
          if (!entries) return t;
          const next = [...t.assignments];
          for (const { index, assignment } of entries.sort((a, b) => a.index - b.index)) {
            next.splice(Math.min(index, next.length), 0, assignment);
          }
          return { ...t, assignments: next };
        }),
      };
    },
  };
}

export function assignResourceCommand(taskId: string, assignment: TaskAssignment): Command {
  // assignment = { resourceId, load }. If the resource is already assigned,
  // this updates its load; otherwise it adds the assignment.
  return {
    label: `分配资源`,
    apply: (file) => ({
      ...file,
      tasks: file.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              assignments: [
                ...t.assignments.filter((a) => a.resourceId !== assignment.resourceId),
                assignment,
              ],
            }
          : t,
      ),
    }),
    invert: (file) => file, // best-effort — full inverse captured at dispatch site
  };
}

export function unassignResourceCommand(taskId: string, resourceId: string): Command {
  let oldAssignment: TaskAssignment | null = null;
  return {
    label: `取消分配`,
    apply: (file) => {
      const task = file.tasks.find((t) => t.id === taskId);
      const existing = task?.assignments.find((a) => a.resourceId === resourceId);
      if (!existing) return file;
      oldAssignment = existing;
      return {
        ...file,
        tasks: file.tasks.map((t) =>
          t.id === taskId
            ? { ...t, assignments: t.assignments.filter((a) => a.resourceId !== resourceId) }
            : t,
        ),
      };
    },
    invert: (file) => {
      if (!oldAssignment) return file;
      const restore = oldAssignment;
      return {
        ...file,
        tasks: file.tasks.map((t) =>
          t.id === taskId ? { ...t, assignments: [...t.assignments, restore] } : t,
        ),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Constraint commands (P1 feature three — C2.1)
// ---------------------------------------------------------------------------

export function updateConstraintCommand(taskId: string, constraint: TaskConstraints): Command {
  let capturedOldValues: Map<string, Partial<Task>> | null = null;
  return {
    label: `更新约束`,
    apply: (file) => {
      capturedOldValues = new Map();
      const target = file.tasks.find((t) => t.id === taskId);
      if (!target) return file;

      // 1. Apply the constraint field change.
      let tasks = applyPatchAndCapture(
        file.tasks,
        taskId,
        { constraints: constraint },
        capturedOldValues,
      );

      // 2. If the constraint affects dates, recompute the task's start/end via
      // satisfyConstraint, then cascade to dependents.
      const cal = resolveCalendar(getCalendar(file.calendar.id));
      const updated = tasks.find((t) => t.id === taskId)!;
      const result = satisfyConstraint(updated, constraint, cal, updated.start);
      if (result.start !== target.start || result.end !== target.end) {
        tasks = applyPatchAndCapture(
          tasks,
          taskId,
          { start: result.start, end: result.end },
          capturedOldValues,
        );
        // Cascade to successors.
        const cascadePatches = cascadeSchedule(tasks, taskId, cal);
        for (const cp of cascadePatches) {
          tasks = applyPatchAndCapture(tasks, cp.id, cp.patch, capturedOldValues);
        }
      }

      return { ...file, tasks };
    },
    invert: (file) => {
      if (!capturedOldValues) return file;
      return { ...file, tasks: restoreCaptured(file.tasks, capturedOldValues) };
    },
  };
}

// ---------------------------------------------------------------------------
// Baseline commands (baseline-comparison spec §6.3)
//
// Baselines are immutable snapshots: create / rename / delete only — there is
// intentionally NO `updateBaselineSnapshot` command (spec §2.1). The UI sets
// `useViewStore.activeBaselineId` separately (it is ephemeral, not project
// data), so these commands stay pure and never touch the view store.
// ---------------------------------------------------------------------------

/**
 * Append a captured baseline snapshot to `file.baselines`. Undo removes it by
 * id; redo re-appends the SAME snapshot object (stable reference).
 */
export function createBaselineCommand(baseline: Baseline): Command {
  return {
    label: `创建基线: ${baseline.name}`,
    apply: (file) => ({ ...file, baselines: [...file.baselines, baseline] }),
    invert: (file) => ({
      ...file,
      baselines: file.baselines.filter((b) => b.id !== baseline.id),
    }),
  };
}

/**
 * Rename a baseline. Captures the prior name on first apply so undo restores
 * it. Never touches `capturedAt` or the task snapshot.
 */
export function renameBaselineCommand(baselineId: string, name: string): Command {
  let oldName: string | null = null;
  return {
    label: `重命名基线`,
    apply: (file) => {
      const existing = file.baselines.find((b) => b.id === baselineId);
      if (!existing) return file;
      oldName = existing.name;
      return {
        ...file,
        baselines: file.baselines.map((b) => (b.id === baselineId ? { ...b, name } : b)),
      };
    },
    invert: (file) => {
      if (oldName === null) return file;
      const restore = oldName;
      return {
        ...file,
        baselines: file.baselines.map((b) => (b.id === baselineId ? { ...b, name: restore } : b)),
      };
    },
  };
}

/**
 * Delete a baseline. On first apply it captures the baseline object AND its
 * original array position so undo restores both data and order (spec §6.3).
 */
export function deleteBaselineCommand(baselineId: string): Command {
  let captured: { baseline: Baseline; index: number } | null = null;
  return {
    label: `删除基线`,
    apply: (file) => {
      const index = file.baselines.findIndex((b) => b.id === baselineId);
      if (index === -1) return file;
      captured = { baseline: file.baselines[index]!, index };
      return {
        ...file,
        baselines: file.baselines.filter((b) => b.id !== baselineId),
      };
    },
    invert: (file) => {
      if (!captured) return file;
      const { baseline, index } = captured;
      const next = [...file.baselines];
      // Clamp index in case the array shrank elsewhere; splice handles it.
      next.splice(Math.min(index, next.length), 0, baseline);
      return { ...file, baselines: next };
    },
  };
}
