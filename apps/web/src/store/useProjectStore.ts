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
import { computeCascadeRollup } from '@/lib/summary';

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

// ---------------------------------------------------------------------------
// Rollup-aware commands
// ---------------------------------------------------------------------------

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

      // 1. Apply patch to target task
      let tasks = file.tasks.map((t) => {
        if (t.id !== taskId) return t;
        // Capture old values for target
        const old: Partial<Task> = {};
        for (const key of Object.keys(patch) as Array<keyof Task>) {
          (old as Record<string, unknown>)[key] = t[key];
        }
        capturedOldValues!.set(t.id, old);
        return { ...t, ...patch };
      });

      // 2. Compute cascade rollup
      const rollupPatches = computeCascadeRollup(tasks, taskId);

      // 3. Apply rollup patches to ancestors
      for (const { id, patch: rp } of rollupPatches) {
        tasks = tasks.map((t) => {
          if (t.id !== id) return t;
          // Capture old values for ancestor
          const old: Partial<Task> = {};
          for (const key of Object.keys(rp) as Array<keyof Task>) {
            (old as Record<string, unknown>)[key] = t[key];
          }
          capturedOldValues!.set(id, old);
          return { ...t, ...rp };
        });
      }

      return { ...file, tasks };
    },
    invert: (file) => {
      if (!capturedOldValues) return file;
      const oldVals = capturedOldValues;
      return {
        ...file,
        tasks: file.tasks.map((t) => {
          const old = oldVals.get(t.id);
          return old ? { ...t, ...old } : t;
        }),
      };
    },
  };
}

/**
 * Move a task and rollup both old and new parent chains.
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

      // Capture old values
      capturedOldValues.set(taskId, { parentId: oldParentId, order: oldOrder });

      // Apply move
      let tasks = file.tasks.map((t) =>
        t.id === taskId ? { ...t, parentId: newParentId, order: newOrder } : t,
      );

      // Rollup old parent chain (if old parent still has children)
      if (oldParentId) {
        const oldPatches = computeCascadeRollup(tasks, oldParentId);
        for (const { id, patch } of oldPatches) {
          tasks = tasks.map((t) => {
            if (t.id !== id) return t;
            const old: Partial<Task> = {};
            for (const key of Object.keys(patch) as Array<keyof Task>) {
              (old as Record<string, unknown>)[key] = t[key];
            }
            if (!capturedOldValues!.has(id)) capturedOldValues!.set(id, old);
            return { ...t, ...patch };
          });
        }
      }

      // Rollup new parent chain
      if (newParentId) {
        const newPatches = computeCascadeRollup(tasks, newParentId);
        for (const { id, patch } of newPatches) {
          tasks = tasks.map((t) => {
            if (t.id !== id) return t;
            const old: Partial<Task> = {};
            for (const key of Object.keys(patch) as Array<keyof Task>) {
              (old as Record<string, unknown>)[key] = t[key];
            }
            if (!capturedOldValues!.has(id)) capturedOldValues!.set(id, old);
            return { ...t, ...patch };
          });
        }
      }

      return { ...file, tasks };
    },
    invert: (file) => {
      if (!capturedOldValues) return file;
      const oldVals = capturedOldValues;
      return {
        ...file,
        tasks: file.tasks.map((t) => {
          const old = oldVals.get(t.id);
          return old ? { ...t, ...old } : t;
        }),
      };
    },
  };
}
