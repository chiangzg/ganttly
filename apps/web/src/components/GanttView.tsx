/**
 * Top-level Gantt editor view (PRD §5.1).
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │ ProjectHeader + Toolbar                         │
 *   ├──────────────┬───────────────────┬──────────────┤
 *   │ TaskTable    │ GanttCanvas       │ TaskDrawer   │
 *   │ (WBS list)   │ (date grid+bars)  │ (docked      │
 *   │              │                   │  inspector)  │
 *   ├──────────────┴───────────────────┴──────────────┤
 *   │ StatusBar                                       │
 *   └─────────────────────────────────────────────────┘
 *
 * The TaskDrawer is a DOCKED inspector (plan §3.7): a sibling flex child of
 * the main content row (not a page-level absolute overlay), so opening it
 * shrinks the canvas via its existing ResizeObserver instead of covering the
 * toolbar/canvas. It renders null when closed.
 *
 * The TaskTable and GanttCanvas share scroll-Y (a row at index N must align
 * on both sides). The Toolbar drives high-level actions; the StatusBar shows
 * save state and undo/redo availability.
 */
import { Toolbar } from './Toolbar';
import { TaskTable } from './TaskTable';
import { GanttCanvas } from './GanttCanvas';
import { ResourceList } from './ResourceList';
import { ResourceLoadCanvas } from './ResourceLoadCanvas';
import { StatusBar } from './StatusBar';
import { TaskDrawer } from './TaskDrawer';
import { ContextMenu } from './ContextMenu';
import { BatchActionBar } from './BatchActionBar';
import { RemoteUpdateBanner } from './editor/RemoteUpdateBanner';
import { useViewStore } from '@/store/useViewStore';
import { ProjectHeader } from './projects/ProjectHeader';
import { UndoToastStack } from '@/lib/toast';
import { useEditorShortcuts } from './useEditorShortcuts';
import { useRemoteEvents } from '@/hooks/useRemoteEvents';

export function GanttView() {
  const viewMode = useViewStore((s) => s.viewMode);
  // Global undo/redo/save shortcuts (plan §4.2). Mounted here so the listener
  // is alive whenever the editor is on screen, regardless of which pane has focus.
  useEditorShortcuts();
  // Subscribe to remote workspace events (spec §11.3); no-op for local scope.
  useRemoteEvents();

  return (
    <div className="flex h-full flex-col">
      <div data-editor-navigation className="shrink-0">
        <ProjectHeader />
        <Toolbar />
      </div>
      <RemoteUpdateBanner />
      {/* `relative` anchors the floating BatchActionBar (plan §4.6). */}
      <div className="relative flex flex-1 overflow-hidden">
        {viewMode === 'resource' ? (
          <>
            <ResourceList />
            <ResourceLoadCanvas />
            <TaskDrawer />
          </>
        ) : (
          <>
            <TaskTable />
            <GanttCanvas />
            <TaskDrawer />
          </>
        )}
        <BatchActionBar />
      </div>
      <StatusBar />
      <ContextMenu />
      <UndoToastStack />
    </div>
  );
}
