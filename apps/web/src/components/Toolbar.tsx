/**
 * Toolbar — top action bar (PRD §3.10).
 *
 * MVP exposes:
 * - Today button (jumps scroll to today)
 * - Zoom in/out (cycles day → week → month → year)
 * - Critical path toggle (M3 — wired now)
 * - New task
 * - Undo / Redo (with status-bar descriptive labels)
 * - Save (manual, even though autosave is on)
 * - Import / Export menu (M4)
 */
import { useTranslation } from 'react-i18next';
import { useProjectStore, setViewStateCommand } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { todayISO } from '@/engine/layout';
import { dateToPixel, pixelsPerDay } from '@/engine/layout';
import type { ZoomLevel } from '@ganttly/schema';
import { ToolbarButton } from './ui/ToolbarButton';
import { ToolbarDivider } from './ui/ToolbarDivider';
import { ExportMenu } from './ExportMenu';
import { ImportMenu } from './ImportMenu';
import { nanoid } from 'nanoid';
import { addTaskCommand } from '@/store/useProjectStore';
import type { Task } from '@ganttly/schema';

const ZOOM_ORDER: ZoomLevel[] = ['day', 'week', 'month', 'year'];

export function Toolbar() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const save = useProjectStore((s) => s.save);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const canUndo = useProjectStore((s) => s.canUndo());
  const canRedo = useProjectStore((s) => s.canRedo());
  const nextUndoLabel = useProjectStore((s) => s.nextUndoLabel());
  const nextRedoLabel = useProjectStore((s) => s.nextRedoLabel());
  const openDrawer = useViewStore((s) => s.openDrawer);

  const jumpToToday = () => {
    const today = todayISO();
    const px = dateToPixel(today, file.tasks[0]?.start ?? today, file.viewState.zoom);
    dispatch(setViewStateCommand({ scrollLeft: Math.max(0, px - 200) }));
  };

  const zoomIn = () => {
    const idx = ZOOM_ORDER.indexOf(file.viewState.zoom);
    const next = ZOOM_ORDER[Math.max(0, idx - 1)]!;
    dispatch(setViewStateCommand({ zoom: next }));
  };

  const zoomOut = () => {
    const idx = ZOOM_ORDER.indexOf(file.viewState.zoom);
    const next = ZOOM_ORDER[Math.min(ZOOM_ORDER.length - 1, idx + 1)]!;
    dispatch(setViewStateCommand({ zoom: next }));
  };

  const toggleCriticalPath = () => {
    dispatch(setViewStateCommand({ showCriticalPath: !file.viewState.showCriticalPath }));
  };

  const addRootTask = () => {
    const start = todayISO();
    const id = nanoid(10);
    const task: Task = {
      id,
      name: t('table.placeholderName'),
      parentId: null,
      order: file.tasks.filter((x) => x.parentId === null).length,
      start,
      end: start,
      duration: 1,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: {},
      assignments: [],
      customFields: {},
    };
    // Select the new task atomically with creating it, then open the drawer.
    dispatch(addTaskCommand(task, null, task.order));
    dispatch(setViewStateCommand({ selectedTaskId: id }));
    openDrawer();
  };

  // pixelsPerDay unused in this component — silence import.
  void pixelsPerDay;

  return (
    <div className="flex items-center gap-1 border-b border-border bg-bg-elevated px-3 py-2">
      <ToolbarButton onClick={jumpToToday} title={t('toolbar.today')}>
        {t('toolbar.today')}
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton onClick={zoomIn} title={t('toolbar.zoomIn')}>
        +
      </ToolbarButton>
      <span className="px-2 text-sm font-medium text-fg">
        {t(`toolbar.zoom${cap(file.viewState.zoom)}`)}
      </span>
      <ToolbarButton onClick={zoomOut} title={t('toolbar.zoomOut')}>
        −
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton
        onClick={toggleCriticalPath}
        title={t('toolbar.criticalPath')}
        pressed={file.viewState.showCriticalPath}
      >
        {file.viewState.showCriticalPath
          ? t('toolbar.hideCriticalPath')
          : t('toolbar.showCriticalPath')}
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton onClick={addRootTask} title={t('toolbar.newTask')}>
        {t('toolbar.newTask')}
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton
        onClick={undo}
        disabled={!canUndo}
        title={nextUndoLabel ? t('status.undo', { label: nextUndoLabel }) : t('toolbar.undo')}
      >
        ⟲ {t('toolbar.undo')}
      </ToolbarButton>
      <ToolbarButton
        onClick={redo}
        disabled={!canRedo}
        title={nextRedoLabel ? t('status.redo', { label: nextRedoLabel }) : t('toolbar.redo')}
      >
        ⟳ {t('toolbar.redo')}
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton onClick={() => void save()} title={t('toolbar.save')}>
        {t('toolbar.save')}
      </ToolbarButton>
      <div className="ml-auto flex items-center gap-1">
        <ImportMenu />
        <ExportMenu />
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
