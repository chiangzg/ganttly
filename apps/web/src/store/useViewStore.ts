/**
 * View store — ephemeral UI state (PRD §5.4).
 *
 * Stores state that does NOT go into the project file or the undo stack:
 * - Whether the edit drawer is open
 * - Whether a context menu is open and where
 * - Pending drag state (task-bar drag, dependency-line drag)
 *
 * Persisted view state (zoom, scroll, selection) lives in the project file's
 * `viewState` field instead.
 */
import { create } from 'zustand';

export type DrawerMode = 'closed' | 'edit';

interface ViewStoreState {
  drawer: DrawerMode;
  openDrawer(): void;
  closeDrawer(): void;

  /** Context menu state (right-click on a task). */
  contextMenu: { taskId: string; x: number; y: number } | null;
  openContextMenu(taskId: string, x: number, y: number): void;
  closeContextMenu(): void;
}

export const useViewStore = create<ViewStoreState>((set) => ({
  drawer: 'closed',
  openDrawer: () => set({ drawer: 'edit' }),
  closeDrawer: () => set({ drawer: 'closed' }),

  contextMenu: null,
  openContextMenu: (taskId, x, y) => set({ contextMenu: { taskId, x, y } }),
  closeContextMenu: () => set({ contextMenu: null }),
}));
