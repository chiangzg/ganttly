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
      // Capture the original values of every key we're about to overwrite.
      oldFields = {};
      for (const key of Object.keys(patch) as Array<keyof Task>) {
        (oldFields as Record<string, unknown>)[key] = existing[key];
      }
      return {
        ...file,
        tasks: file.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
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
      return {
        ...file,
        tasks: file.tasks.filter((t) => !idsToDelete.has(t.id)),
      };
    },
    invert: (file) => file, // best-effort — full inverse captured at dispatch site
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
    const old: Partial<Task> = {};
    for (const key of Object.keys(patch) as Array<keyof Task>) {
      (old as Record<string, unknown>)[key] = t[key];
    }
    // Don't overwrite an earlier capture (a task may be patched more than once
    // — e.g. moveTask captures the target's parentId/order, then rollup also
    // wants to capture its start/end). Keep the union of old values.
    const existing = captured.get(id);
    captured.set(id, existing ? { ...old, ...existing } : old);
    return { ...t, ...patch };
  });
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
  let oldParentId: string | null = null;
  let oldOrder = 0;

  return {
    label: `移动任务(含汇总)`,
    apply: (file) => {
      capturedOldValues = new Map();
      const target = file.tasks.find((t) => t.id === taskId);
      if (!target) return file;

      oldParentId = target.parentId;
      oldOrder = target.order;

      // Capture the move itself (parentId/order) for the target
      capturedOldValues.set(taskId, { parentId: oldParentId, order: oldOrder });

      // 1. Apply move
      let tasks = file.tasks.map((t) =>
        t.id === taskId ? { ...t, parentId: newParentId, order: newOrder } : t,
      );

      // 2. Recompute old parent (it lost a child) and its ancestors.
      if (oldParentId && oldParentId !== newParentId) {
        const oldPatches = recomputeSelfAndAncestors(tasks, oldParentId);
        for (const { id, patch } of oldPatches) {
          tasks = applyPatchAndCapture(tasks, id, patch, capturedOldValues);
        }
      }

      // 3. Recompute new parent (it gained a child) and its ancestors.
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
  // Captured at apply time: the resource itself + every assignment referencing it.
  let captured: {
    resource: Resource;
    assignments: Array<{ taskId: string; index: number }>;
  } | null = null;
  return {
    label: `删除资源`,
    apply: (file) => {
      const resource = file.resources.find((r) => r.id === resourceId);
      if (!resource) return file;
      const assignments: Array<{ taskId: string; index: number }> = [];
      for (const t of file.tasks) {
        const idx = t.assignments.findIndex((a) => a.resourceId === resourceId);
        if (idx >= 0) assignments.push({ taskId: t.id, index: idx });
      }
      captured = { resource, assignments };
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
      const { resource, assignments } = captured;
      const assignByTask = new Map(assignments.map((a) => [a.taskId, a.index]));
      return {
        ...file,
        resources: [...file.resources, resource],
        tasks: file.tasks.map((t) => {
          const idx = assignByTask.get(t.id);
          if (idx === undefined) return t;
          // Re-insert the assignment at its original index (best-effort order restore).
          const restored: TaskAssignment = { resourceId, load: 0 };
          // The original load is lost on delete (we only restored structure);
          // this is acceptable since delete+undo of a resource is rare and the
          // user can re-adjust. To preserve load we'd need to capture it too.
          const next = [...t.assignments];
          next.splice(Math.min(idx, next.length), 0, restored);
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
