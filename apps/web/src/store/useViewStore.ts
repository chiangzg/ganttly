/**
 * View store — ephemeral UI state (PRD §5.4).
 *
 * Stores state that does NOT go into the project file or the undo stack:
 * - Whether the edit drawer is open
 * - Whether a context menu is open and where
 * - The active view mode (task ↔ resource) — G11: ephemeral, not persisted,
 *   consistent with how scroll/zoom navigation bypasses the undo stack.
 * - Resource-view scroll position — G19: separate from `file.viewState.scrollTop`
 *   because task rows (N) and resource rows (M) differ in count; sharing one
 *   scrollTop would land the wrong row on view switch.
 * - Resource-view selection — G19: independent of `file.viewState.selectedTaskId`;
 *   switching views does not clear the other's selection.
 * - Resource-view drill-down (which resources are expanded, and which drilled
 *   task lane is highlighted) — G11/G19: ephemeral, independent of the task
 *   view's selection.
 *
 * Persisted view state (zoom, scroll, selection) lives in the project file's
 * `viewState` field instead.
 */
import { create } from 'zustand';
import { clampDrawerWidth, loadDrawerWidth, saveDrawerWidth } from '@/lib/drawerWidthPrefs';
import type { TaskFilter } from '@/lib/taskFilter';
import type { SelectionState } from '@/lib/selection';
import { useProjectStore } from '@/store/useProjectStore';

// Re-export the width bounds so callers can import them from the store path
// (keeps a single import site for ephemeral UI state + its constants).
export { DEFAULT_DRAWER_WIDTH, MIN_DRAWER_WIDTH, MAX_DRAWER_WIDTH } from '@/lib/drawerWidthPrefs';

export type DrawerMode = 'closed' | 'edit';
export type ViewMode = 'task' | 'resource';

interface ViewStoreState {
  drawer: DrawerMode;
  openDrawer(): void;
  closeDrawer(): void;

  /**
   * Docked inspector width in CSS px (plan §3.7). A user preference — NOT
   * project data, NOT in the undo stack — persisted to localStorage across
   * sessions. Clamped to [MIN_DRAWER_WIDTH, MAX_DRAWER_WIDTH].
   */
  drawerWidth: number;
  setDrawerWidth(width: number): void;

  /**
   * Context menu state (right-click on a task row/bar OR a resource row in
   * the resource view). One shell (ContextMenu.tsx) renders task or resource
   * items depending on `kind`.
   */
  contextMenu:
    | { kind: 'task'; taskId: string; x: number; y: number }
    | { kind: 'resource'; resourceId: string; x: number; y: number }
    | null;
  openContextMenu(taskId: string, x: number, y: number): void;
  openResourceContextMenu(resourceId: string, x: number, y: number): void;
  closeContextMenu(): void;

  /**
   * One-shot inline-rename request. The context menu (outside TaskTable) asks
   * TaskTable to start editing a task's name cell; TaskTable owns the
   * editingCell ref, so it watches this field and clears it once handled.
   * `nonce` lets the same task be requested twice in a row. Pure UI state —
   * never in the project file or the undo stack.
   */
  renameRequest: { taskId: string; nonce: number } | null;
  requestRename(taskId: string): void;
  clearRenameRequest(): void;

  /**
   * Resource-view twin of `renameRequest`: the context menu asks
   * ResourceList to start editing a resource's name. Same one-shot
   * nonce pattern; cleared by ResourceList once handled.
   */
  resourceRenameRequest: { resourceId: string; nonce: number } | null;
  requestResourceRename(resourceId: string): void;
  clearResourceRenameRequest(): void;

  /** Active view: task (Gantt) ↔ resource (load chart). G11: ephemeral. */
  viewMode: ViewMode;
  setViewMode(mode: ViewMode): void;

  /** Resource-view vertical scroll (G19: independent of task-view scrollTop). */
  resourceScrollTop: number;
  setResourceScrollTop(top: number): void;

  /** Resource-view selection (G19: independent of selectedTaskId). */
  selectedResourceId: string | null;
  setSelectedResourceId(id: string | null): void;

  /**
   * Resource-view drill-down: expanded resources. Drilling down inserts task
   * lanes beneath the resource row (left list + right canvas align by row).
   * Ephemeral (G11): not persisted, not in the undo stack.
   */
  expandedResourceIds: Set<string>;
  toggleResourceExpanded(resourceId: string): void;

  /**
   * Selected task lane within the resource view (G19: independent of
   * `file.viewState.selectedTaskId`, so highlighting a lane here does not
   * affect the task view). Double-clicking a lane opens the drawer, which
   * reads `selectedTaskId`, so that is set separately at open time.
   */
  selectedTaskIdInResource: string | null;
  setSelectedTaskIdInResource(id: string | null): void;

  /**
   * Active baseline for comparison (baseline-comparison spec §6.1).
   *
   * `null` means "not comparing". This is ephemeral UI state — it does NOT go
   * into the project file or the undo stack, so a page refresh or project
   * switch naturally resets it to `null`. Selecting a different baseline does
   * not mutate project data; it only changes which baseline the Scene/UI reads.
   */
  activeBaselineId: string | null;
  setActiveBaselineId(id: string | null): void;

  /**
   * Task-view search & filter (plan §4.4).
   *
   * Both are EPHEMERAL UI state (plan §9.1): not persisted to the project
   * file, not in the undo stack — they only affect WHICH tasks are displayed,
   * never the task data itself. A page refresh or project switch clears them.
   * Selecting a result calls `revealTask()` to scroll/expand.
   */
  searchQuery: string;
  setSearchQuery(q: string): void;
  taskFilter: TaskFilter;
  setTaskFilter(filter: TaskFilter): void;

  /**
   * Task selection (plan §4.6 multi-select + plan §9.1: selection is ephemeral,
   * NOT in the undo stack).
   *
   * `selectedTaskIds` is the multi-select set (size 1 when single-selecting);
   * `anchorTaskId` is the Shift-range origin AND the "primary" selection that
   * the drawer edits. The anchor is mirrored into
   * `file.viewState.selectedTaskId` (via direct `setState`, NOT dispatch — so it
   * stays out of the undo stack) so the TaskDrawer and Canvas selection ring
   * keep reading their existing single-id field with zero changes.
   *
   * A page refresh or project switch clears the multi-select set; the anchor
   * persists because it lives in the project file's viewState.
   */
  selectedTaskIds: ReadonlySet<string>;
  anchorTaskId: string | null;
  /** Low-level setter that writes the set + anchor and mirrors the anchor. */
  setSelection(next: SelectionState): void;
  /** Replace selection with a single task (plain click / drawer open). */
  selectSingle(taskId: string): void;
  /** Toggle a task in the set (Ctrl/Cmd+Click). */
  toggleSelected(taskId: string): void;
  /** Select the contiguous range from the anchor to `taskId` (Shift+Click). */
  selectRange(taskId: string, visibleIds: ReadonlyArray<string>): void;
  /** Clear selection entirely (Escape / blank-area click). */
  clearSelection(): void;

  /**
   * §4.6 batch-delete signal: the GanttCanvas has no confirm dialog of its own
   * (BatchDeleteConfirm lives in TaskTable), so when the user presses Delete
   * on the canvas with a multi-selection it bumps this counter. TaskTable
   * watches it via useEffect and opens BatchDeleteConfirm for the current
   * selection. A counter (not a boolean) avoids duplicate-fires when several
   * effects race on the same render.
   */
  batchDeleteSignal: number;
  requestBatchDelete(): void;

  resetForProjectSwitch(): void;
}

export const useViewStore = create<ViewStoreState>((set) => ({
  drawer: 'closed',
  openDrawer: () => set({ drawer: 'edit' }),
  closeDrawer: () => set({ drawer: 'closed' }),

  // Initial width is loaded from localStorage (falls back to default). Updates
  // clamp + persist so the preference survives across sessions.
  drawerWidth: loadDrawerWidth(),
  setDrawerWidth: (width) => {
    const next = clampDrawerWidth(width);
    set((s) => (s.drawerWidth === next ? s : { drawerWidth: next }));
    saveDrawerWidth(next);
  },

  contextMenu: null,
  openContextMenu: (taskId, x, y) => set({ contextMenu: { kind: 'task', taskId, x, y } }),
  openResourceContextMenu: (resourceId, x, y) =>
    set({ contextMenu: { kind: 'resource', resourceId, x, y } }),
  closeContextMenu: () => set({ contextMenu: null }),

  renameRequest: null,
  requestRename: (taskId) =>
    set((s) => ({ renameRequest: { taskId, nonce: (s.renameRequest?.nonce ?? 0) + 1 } })),
  clearRenameRequest: () => set({ renameRequest: null }),

  resourceRenameRequest: null,
  requestResourceRename: (resourceId) =>
    set((s) => ({
      resourceRenameRequest: { resourceId, nonce: (s.resourceRenameRequest?.nonce ?? 0) + 1 },
    })),
  clearResourceRenameRequest: () => set({ resourceRenameRequest: null }),

  viewMode: 'task',
  setViewMode: (mode) => set({ viewMode: mode }),

  resourceScrollTop: 0,
  setResourceScrollTop: (top) => set({ resourceScrollTop: top }),

  selectedResourceId: null,
  setSelectedResourceId: (id) => set({ selectedResourceId: id }),

  expandedResourceIds: new Set<string>(),
  toggleResourceExpanded: (resourceId) =>
    set((s) => {
      const next = new Set(s.expandedResourceIds);
      if (next.has(resourceId)) next.delete(resourceId);
      else next.add(resourceId);
      return { expandedResourceIds: next };
    }),

  selectedTaskIdInResource: null,
  setSelectedTaskIdInResource: (id) => set({ selectedTaskIdInResource: id }),

  activeBaselineId: null,
  setActiveBaselineId: (id) => set({ activeBaselineId: id }),

  // Search/filter: empty query + 'none' filter = show everything (the default
  // pre-§4.4 behaviour). Direct setState — navigation/UI, not undoable.
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),
  taskFilter: 'none',
  setTaskFilter: (filter) => set({ taskFilter: filter }),

  // Selection: starts empty. The anchor is mirrored into
  // `file.viewState.selectedTaskId` on every write so the TaskDrawer and Canvas
  // selection ring keep reading their single-id field unchanged. Mirror writes
  // use direct setState (NOT dispatch) so selection never enters the undo stack
  // (plan §9.1).
  selectedTaskIds: new Set<string>(),
  anchorTaskId: null,
  setSelection: (next) => {
    set({ selectedTaskIds: next.ids, anchorTaskId: next.anchor });
    mirrorAnchor(next.anchor);
  },
  selectSingle: (taskId) => {
    set({ selectedTaskIds: new Set([taskId]), anchorTaskId: taskId });
    mirrorAnchor(taskId);
  },
  toggleSelected: (taskId) => {
    const cur = useViewStore.getState();
    const ids = new Set(cur.selectedTaskIds);
    let anchor = cur.anchorTaskId;
    if (ids.has(taskId)) {
      ids.delete(taskId);
      if (anchor === taskId) anchor = ids.values().next().value ?? null;
    } else {
      ids.add(taskId);
      if (anchor === null) anchor = taskId;
    }
    set({ selectedTaskIds: ids, anchorTaskId: anchor });
    mirrorAnchor(anchor);
  },
  selectRange: (taskId, visibleIds) => {
    const cur = useViewStore.getState();
    if (cur.anchorTaskId === null) {
      set({ selectedTaskIds: new Set([taskId]), anchorTaskId: taskId });
      mirrorAnchor(taskId);
      return;
    }
    const ids = rangeBetween(cur.anchorTaskId, taskId, visibleIds);
    set({ selectedTaskIds: ids, anchorTaskId: cur.anchorTaskId });
    mirrorAnchor(cur.anchorTaskId);
  },
  clearSelection: () => {
    set({ selectedTaskIds: new Set<string>(), anchorTaskId: null });
    mirrorAnchor(null);
  },

  batchDeleteSignal: 0,
  requestBatchDelete: () => set((s) => ({ batchDeleteSignal: s.batchDeleteSignal + 1 })),

  resetForProjectSwitch: () =>
    set({
      drawer: 'closed',
      contextMenu: null,
      renameRequest: null,
      resourceRenameRequest: null,
      resourceScrollTop: 0,
      selectedResourceId: null,
      expandedResourceIds: new Set<string>(),
      selectedTaskIdInResource: null,
      activeBaselineId: null,
      // §4.4: clear search/filter so a switched-to project starts unfiltered.
      searchQuery: '',
      taskFilter: 'none',
      // §4.6: clear multi-select on project switch.
      selectedTaskIds: new Set<string>(),
      anchorTaskId: null,
    }),
}));

/**
 * Write the selection anchor into `file.viewState.selectedTaskId` via DIRECT
 * `setState` (never dispatch), so the TaskDrawer and Canvas selection ring —
 * which both read that single field — stay in sync without any changes, while
 * selection itself never enters the undo stack (plan §9.1).
 */
function mirrorAnchor(anchor: string | null): void {
  const project = useProjectStore.getState();
  if (project.file.viewState.selectedTaskId === anchor) return;
  useProjectStore.setState({
    file: {
      ...project.file,
      viewState: { ...project.file.viewState, selectedTaskId: anchor },
    },
  });
}

/**
 * Inclusive contiguous id set between `from` and `to` within `visibleIds`.
 * Order-independent. If either endpoint is missing from the sequence, falls
 * back to the two endpoints. Mirrors the pure helper in lib/selection.ts but
 * is kept local to avoid a runtime import cycle (lib/selection ↔ store).
 */
function rangeBetween(from: string, to: string, visibleIds: ReadonlyArray<string>): Set<string> {
  if (from === to) return new Set([from]);
  const fromIdx = visibleIds.indexOf(from);
  const toIdx = visibleIds.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return new Set([from, to]);
  const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
  const out = new Set<string>();
  for (let i = lo; i <= hi; i++) {
    const id = visibleIds[i];
    if (id !== undefined) out.add(id);
  }
  return out;
}
