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
  applyProjectCommand,
  applyPatchAndCapture,
  type ProjectCommand,
  type ApplyProjectCommandContext,
} from '@ganttly/domain';
import {
  DEFAULT_PROJECT_ID,
  type ProjectRepository,
  type ProjectRevision,
} from '@/data/repository';
import { isLocalRef, localRef, refEqual, type ProjectRef } from '@/data/projectRef';
import { resolveProjectRepository } from '@/data/resolveRepository';
import { cascadeSchedule, countDependencyViolations } from '@/lib/schedule';
import { resolveCalendar } from '@/lib/calendar';
import { useInstanceStore } from './useInstanceStore';
import { useAuthStore } from './useAuthStore';

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
  activeProjectRef: ProjectRef | null;
  revision: ProjectRevision | null;
  dirty: boolean;
  loadState: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  saveState: SaveState;

  // Lifecycle
  setRepository(repo: ProjectRepository): void;
  init(repo: ProjectRepository): Promise<void>;
  loadProject(ref: ProjectRef): Promise<boolean>;
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

function scheduleSave(ref: ProjectRef | null): void {
  clearSaveTimer();
  if (!ref) return;
  saveTimer = setTimeout(() => {
    const state = useProjectStore.getState();
    if (state.activeProjectRef && refEqual(state.activeProjectRef, ref)) void state.save();
  }, 500);
}

/**
 * Resolve the {@link ProjectRepository} for a given ref. Local refs use the
 * injected local repository; remote refs resolve an HTTP-backed
 * {@link RemoteRepository} via the instance/auth stores. Returns null when a
 * remote ref's instance is not yet authenticated — callers treat that as
 * "not loadable".
 */
function resolveRepoForRef(
  ref: ProjectRef,
  localRepo: ProjectRepository | null,
): ProjectRepository | null {
  if (isLocalRef(ref)) return localRepo;
  const instance = useInstanceStore.getState().findInstance(ref.instanceId);
  const profile = useAuthStore.getState().getProfile(ref.instanceId);
  if (!instance || !profile) return null;
  return resolveProjectRepository(ref, { instance, userId: profile.userId });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  file: withCalendar(createEmptyFile()),
  repo: null,
  activeProjectRef: null,
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
      activeProjectRef: null,
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
    await get().loadProject(localRef(snapshot.summary.id));
  },

  async loadProject(ref) {
    const localRepo = get().repo;
    const repo = resolveRepoForRef(ref, localRepo);
    if (!repo) return false;
    if (
      get().activeProjectRef &&
      refEqual(get().activeProjectRef!, ref) &&
      get().loadState === 'ready'
    )
      return true;
    if (get().activeProjectRef && get().dirty) await get().flushPendingSave();

    const generation = ++loadGeneration;
    clearSaveTimer();
    set({ loadState: 'loading', lastSaveError: null });
    try {
      const snapshot = await repo.loadProject(ref.projectId);
      if (generation !== loadGeneration) return false;
      if (!snapshot || snapshot.summary.deletedAt) {
        set({ loadState: 'missing' });
        return false;
      }
      const normalized = withCalendar(snapshot.file);
      set({
        activeProjectRef: ref,
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
      activeProjectRef: null,
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
    scheduleSave(get().activeProjectRef);
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
    scheduleSave(get().activeProjectRef);
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
    scheduleSave(get().activeProjectRef);
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
    scheduleSave(get().activeProjectRef);
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
  const { file, activeProjectRef, revision } = get();
  if (!activeProjectRef || revision === null) return;
  const repo = resolveRepoForRef(activeProjectRef, get().repo);
  if (!repo) return;
  clearSaveTimer();
  set({ saveState: { status: 'saving' } });
  try {
    const stamped: GanttlyFile = {
      ...file,
      meta: { ...file.meta, updatedAt: new Date().toISOString() },
    };
    const snapshot = await repo.saveProject(activeProjectRef.projectId, stamped, {
      expectedRevision: revision,
    });
    const current = get();
    if (!current.activeProjectRef || !refEqual(current.activeProjectRef, activeProjectRef)) return;
    const changedWhileSaving = current.file !== file;
    set({
      file: changedWhileSaving ? current.file : snapshot.file,
      revision: snapshot.revision,
      dirty: changedWhileSaving,
      saveState: { status: changedWhileSaving ? 'saving' : 'saved' },
      lastSaveError: null,
    });
    if (changedWhileSaving) scheduleSave(activeProjectRef);
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
// Built-in commands — thin Web adapters over the pure domain command model
// (plan §4.1 decision 2). Each factory wraps a `ProjectCommand` in
// `toUndoable`, which delegates the forward pass to `applyProjectCommand` and
// restores the pre-apply file snapshot on invert.
// ---------------------------------------------------------------------------

/**
 * Build a local {@link ApplyProjectCommandContext} for Web. The domain never
 * reads the system clock; these values are supplied at apply time so `now` /
 * `today` reflect the moment the user acted. The values are currently unused
 * by the domain (server-side audit fields land in a later PR) but keep the
 * contract honest.
 */
function localCommandCtx(): ApplyProjectCommandContext {
  const now = new Date();
  return {
    now: now.toISOString(),
    today: now.toISOString().slice(0, 10),
    actorId: 'local',
  };
}

/**
 * Wrap a pure domain {@link ProjectCommand} into a Web {@link Command} with
 * snapshot-based undo. The forward pass delegates to `applyProjectCommand`;
 * the invert pass restores the pre-apply file reference captured in the
 * closure. Files are immutable (every command produces new objects via
 * spread), so holding a reference is cheap and provably correct — redo
 * re-runs `apply` on the same reference and reproduces the same result.
 */
function toUndoable(command: ProjectCommand, label: string): Command {
  let beforeFile: GanttlyFile | null = null;
  return {
    label,
    apply: (file) => {
      beforeFile = file;
      return applyProjectCommand(file, command, localCommandCtx()).file;
    },
    invert: (file) => beforeFile ?? file,
  };
}

// --- Task commands ---------------------------------------------------------

export function addTaskCommand(task: Task, parentId: string | null, order: number): Command {
  return toUndoable({ kind: 'addTask', task, parentId, order }, `新增任务: ${task.name}`);
}

export function updateTaskCommand(taskId: string, patch: Partial<Task>): Command {
  return toUndoable({ kind: 'updateTask', taskId, patch }, '更新任务');
}

export function deleteTaskCommand(taskId: string): Command {
  return toUndoable({ kind: 'deleteTask', taskId }, '删除任务');
}

/**
 * Batch-delete multiple tasks as ONE command (plan §4.6). Generalises
 * {@link deleteTaskCommand}: the initial set is closed transitively under
 * `parentId`, so selecting both a parent and its child deletes the subtree
 * once rather than twice.
 */
export function batchDeleteTasksCommand(ids: ReadonlyArray<string>): Command {
  return toUndoable({ kind: 'batchDeleteTasks', ids }, '批量删除任务');
}

export function addDependencyCommand(successorId: string, dep: Dependency): Command {
  return toUndoable({ kind: 'addDependency', successorId, dependency: dep }, '新增依赖');
}

export function deleteDependencyCommand(successorId: string, targetId: string): Command {
  return toUndoable({ kind: 'deleteDependency', successorId, targetId }, '删除依赖');
}

export function moveTaskCommand(
  taskId: string,
  newParentId: string | null,
  newOrder: number,
): Command {
  return toUndoable({ kind: 'moveTask', taskId, newParentId, newOrder }, '移动任务');
}

export function setViewStateCommand(patch: Partial<ViewState>): Command {
  return toUndoable({ kind: 'setViewState', patch }, '视图变更');
}

export function swapSiblingOrderCommand(aId: string, bId: string): Command {
  return toUndoable({ kind: 'swapSiblingOrder', aId, bId }, '调整顺序');
}

/**
 * Insert a copy of `template` as the next sibling of `anchorId`, bumping the
 * order of all later siblings. Used by paste (PRD §3.10 Ctrl+V).
 */
export function pasteTaskCommand(template: Task, anchorId: string): Command {
  return toUndoable({ kind: 'pasteTask', template, anchorId }, '粘贴任务');
}

/** Update a task and cascade rollup to all ancestors + dependency successors. */
export function updateTaskWithRollupCommand(taskId: string, patch: Partial<Task>): Command {
  return toUndoable({ kind: 'updateTaskWithRollup', taskId, patch }, '更新任务(含汇总)');
}

/**
 * Commit a full task-draft edit as ONE undoable command (editor-interaction-
 * optimization-plan §2.2 / §6.5). The domain three-way merges the fields
 * changed between `before` and `after` onto the live task, then re-runs the
 * same rollup + dependency cascade that a live date edit would. One save =
 * one undo (plan §6.5).
 */
export function updateTaskFromDraftCommand(before: Task, after: Task): Command {
  return toUndoable(
    { kind: 'updateTaskFromDraft', before, after },
    `保存任务: ${after.name || before.name}`,
  );
}

/** Move a task and rollup both old and new parent chains (plan §2.3). */
export function moveTaskWithRollupCommand(
  taskId: string,
  newParentId: string | null,
  newOrder: number,
): Command {
  return toUndoable(
    { kind: 'moveTaskWithRollup', taskId, newParentId, newOrder },
    '移动任务(含汇总)',
  );
}

// --- Resource commands -----------------------------------------------------

export function addResourceCommand(resource: Resource): Command {
  return toUndoable({ kind: 'addResource', resource }, `新增资源: ${resource.name}`);
}

export function updateResourceCommand(resourceId: string, patch: Partial<Resource>): Command {
  return toUndoable({ kind: 'updateResource', resourceId, patch }, '更新资源');
}

export function deleteResourceCommand(resourceId: string): Command {
  return toUndoable({ kind: 'deleteResource', resourceId }, '删除资源');
}

export function assignResourceCommand(taskId: string, assignment: TaskAssignment): Command {
  return toUndoable({ kind: 'assignResource', taskId, assignment }, '分配资源');
}

/**
 * Batch-assign a resource to multiple tasks as ONE command (plan §4.6).
 * Targets are the selected LEAF tasks — summary tasks are skipped so
 * person-days are never double-counted. One undo reverts the whole batch.
 */
export function batchAssignResourceCommand(
  taskIds: ReadonlyArray<string>,
  assignment: TaskAssignment,
): Command {
  return toUndoable({ kind: 'batchAssignResource', taskIds, assignment }, '批量分配资源');
}

export function unassignResourceCommand(taskId: string, resourceId: string): Command {
  return toUndoable({ kind: 'unassignResource', taskId, resourceId }, '取消分配');
}

// --- Constraint & baseline commands ----------------------------------------

export function updateConstraintCommand(taskId: string, constraint: TaskConstraints): Command {
  return toUndoable({ kind: 'updateConstraint', taskId, constraint }, '更新约束');
}

/**
 * Baselines are immutable snapshots: create / rename / delete only (spec §2.1).
 * The UI sets `useViewStore.activeBaselineId` separately (ephemeral, not
 * project data), so these commands stay pure and never touch the view store.
 */
export function createBaselineCommand(baseline: Baseline): Command {
  return toUndoable({ kind: 'createBaseline', baseline }, `创建基线: ${baseline.name}`);
}

export function renameBaselineCommand(baselineId: string, name: string): Command {
  return toUndoable({ kind: 'renameBaseline', baselineId, name }, '重命名基线');
}

export function deleteBaselineCommand(baselineId: string): Command {
  return toUndoable({ kind: 'deleteBaseline', baselineId }, '删除基线');
}
