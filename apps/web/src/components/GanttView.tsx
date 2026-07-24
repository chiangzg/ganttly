/**
 * Top-level Gantt editor view (PRD §5.1).
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │ Toolbar                                         │
 *   ├──────────────┬──────────────────────────────────┤
 *   │ TaskTable    │ GanttCanvas                      │
 *   │ (WBS list)   │ (date grid + bars + arrows)      │
 *   │              │                                  │
 *   ├──────────────┴──────────────────────────────────┤
 *   │ StatusBar                                       │
 *   └─────────────────────────────────────────────────┘
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
import { useViewStore } from '@/store/useViewStore';
import { ProjectHeader } from './projects/ProjectHeader';

export function GanttView() {
  const viewMode = useViewStore((s) => s.viewMode);

  return (
    <div className="flex h-full flex-col">
      <ProjectHeader />
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        {viewMode === 'resource' ? (
          <>
            <ResourceList />
            <ResourceLoadCanvas />
          </>
        ) : (
          <>
            <TaskTable />
            <GanttCanvas />
          </>
        )}
      </div>
      <StatusBar />
      <TaskDrawer />
      <ContextMenu />
    </div>
  );
}
