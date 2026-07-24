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

export type DrawerMode = 'closed' | 'edit';
export type ViewMode = 'task' | 'resource';

interface ViewStoreState {
  drawer: DrawerMode;
  openDrawer(): void;
  closeDrawer(): void;

  /** Context menu state (right-click on a task). */
  contextMenu: { taskId: string; x: number; y: number } | null;
  openContextMenu(taskId: string, x: number, y: number): void;
  closeContextMenu(): void;

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

  /** Show the person-days column in TaskTable (G11: ephemeral, not persisted). */
  showCostColumns: boolean;
  setShowCostColumns(v: boolean): void;

  resetForProjectSwitch(): void;
}

export const useViewStore = create<ViewStoreState>((set) => ({
  drawer: 'closed',
  openDrawer: () => set({ drawer: 'edit' }),
  closeDrawer: () => set({ drawer: 'closed' }),

  contextMenu: null,
  openContextMenu: (taskId, x, y) => set({ contextMenu: { taskId, x, y } }),
  closeContextMenu: () => set({ contextMenu: null }),

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

  showCostColumns: false,
  setShowCostColumns: (v) => set({ showCostColumns: v }),

  resetForProjectSwitch: () =>
    set({
      drawer: 'closed',
      contextMenu: null,
      resourceScrollTop: 0,
      selectedResourceId: null,
      expandedResourceIds: new Set<string>(),
      selectedTaskIdInResource: null,
    }),
}));
