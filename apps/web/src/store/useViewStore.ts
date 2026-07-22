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

  /** Show the person-days column in TaskTable (G11: ephemeral, not persisted). */
  showCostColumns: boolean;
  setShowCostColumns(v: boolean): void;
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

  showCostColumns: false,
  setShowCostColumns: (v) => set({ showCostColumns: v }),
}));
