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
import type { GanttlyFile, Task, Dependency, ViewState } from '@ganttly/schema';
import { createEmptyFile } from '@ganttly/schema';
import { getCalendar } from '@ganttly/calendar-data';
import { DEFAULT_PROJECT_ID, type ProjectRepository } from '@/data/repository';
import { computeCascadeRollup, recomputeSelfAndAncestors } from '@/lib/summary';

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
  saveState: SaveState;

  // Lifecycle
  init(repo: ProjectRepository): Promise<void>;
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

function withCalendar(file: GanttlyFile): GanttlyFile {
  // On first creation, populate holidays from bundled zh-CN dataset.
  if (file.calendar.holidays.length === 0 && file.calendar.id === 'zh-CN') {
    const cal = getCalendar('zh-CN');
    return { ...file, calendar: { ...file.calendar, holidays: cal.holidays } };
  }
  return file;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  file: withCalendar(createEmptyFile()),
  repo: null,
  saveState: { status: 'idle' },
  undoStack: [],
  redoStack: [],
  lastSaveError: null,

  async init(repo) {
    set({ repo });
    let file = await repo.load(DEFAULT_PROJECT_ID);
    if (!file) {
      file = withCalendar(createEmptyFile({ name: '我的项目' }));
      await repo.save(DEFAULT_PROJECT_ID, file);
    }
    set({ file: withCalendar(file!), saveState: { status: 'saved' } });
  },

  setFile(file) {
    set({ file });
  },

  dispatch(command) {
    const { file } = get();
    const next = command.apply(file);
    set({
      file: next,
      undoStack: [...get().undoStack, command],
      redoStack: [], // any new action clears redo
      saveState: { status: 'saving' },
    });
    // Debounced autosave (PRD §3.8 — 500ms).
    if (saveTimer) clearTimeout(saveTimer);
    const { repo } = get();
    saveTimer = setTimeout(() => {
      void get().save();
    }, 500);
    void repo; // satisfy lints
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
      saveState: { status: 'saving' },
    });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().save(), 500);
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
      saveState: { status: 'saving' },
    });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().save(), 500);
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
    const { repo, file } = get();
    if (!repo) return;
    set({ saveState: { status: 'saving' } });
    try {
      const stamped: GanttlyFile = {
        ...file,
        meta: { ...file.meta, updatedAt: new Date().toISOString() },
      };
      await repo.save(DEFAULT_PROJECT_ID, stamped);
      set({ file: stamped, saveState: { status: 'saved' }, lastSaveError: null });
    } catch (err) {
      const msg = (err as Error).message;
      set({ saveState: { status: 'error', error: msg }, lastSaveError: msg });
    }
  },
}));

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
  return {
    label: `新增依赖`,
    apply: (file) => ({
      ...file,
      tasks: file.tasks.map((t) =>
        t.id === successorId
          ? {
              ...t,
              dependencies: [...t.dependencies.filter((d) => d.targetId !== dep.targetId), dep],
            }
          : t,
      ),
    }),
    invert: (file) => ({
      ...file,
      tasks: file.tasks.map((t) =>
        t.id === successorId
          ? { ...t, dependencies: t.dependencies.filter((d) => d.targetId !== dep.targetId) }
          : t,
      ),
    }),
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
