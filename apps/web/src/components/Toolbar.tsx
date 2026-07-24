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
import { dateToPixel } from '@/engine/layout';
import { originDateFor } from '@/engine/scene';
import type { ZoomLevel } from '@ganttly/schema';
import { ToolbarButton } from './ui/ToolbarButton';
import { ToolbarDivider } from './ui/ToolbarDivider';
import { ExportMenu } from './ExportMenu';
import { ImportMenu } from './ImportMenu';
import { nanoid } from 'nanoid';
import { addTaskCommand } from '@/store/useProjectStore';
import type { Task } from '@ganttly/schema';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';

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
    // Use the SAME origin the renderer uses (assembleScene → originDateFor).
    // The previous code used file.tasks[0]?.start, which diverged from the
    // renderer's min(earliest task, project.startDate ?? '2026-01-05') and so
    // the "today" button landed on the wrong column (e.g. February).
    const origin = originDateFor(file);
    const today = todayISO();
    const px = dateToPixel(today, origin, file.viewState.zoom);
    // Center today in the chart viewport instead of a fixed -200px offset.
    // The chart container is the element right of the task table.
    const chartEl = document.querySelector('[data-gantt-chart]') as HTMLElement | null;
    const viewportWidth = chartEl ? chartEl.clientWidth : 800;
    const scrollLeft = Math.max(0, px - viewportWidth / 2);
    // Direct setState, not dispatch — a "go to today" jump is navigation, not
    // an undoable edit.
    useProjectStore.setState({
      file: {
        ...file,
        viewState: { ...file.viewState, scrollLeft },
      },
    });
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
      constraints: { type: 'none' },
      assignments: [],
      customFields: {},
    };
    // Select the new task atomically with creating it, then open the drawer.
    dispatch(addTaskCommand(task, null, task.order));
    dispatch(setViewStateCommand({ selectedTaskId: id }));
    openDrawer();
  };

  const viewMode = useViewStore((s) => s.viewMode);
  const setViewMode = useViewStore((s) => s.setViewMode);
  const showCostColumns = useViewStore((s) => s.showCostColumns);
  const setShowCostColumns = useViewStore((s) => s.setShowCostColumns);

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-border bg-bg-elevated px-3">
      <ToolbarButton onClick={jumpToToday} title={t('toolbar.today')}>
        {t('toolbar.today')}
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton onClick={zoomIn} title={t('toolbar.zoomIn')}>
        +
      </ToolbarButton>
      <span className="shrink-0 whitespace-nowrap px-2 text-sm font-medium text-fg">
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
      <ToolbarButton
        onClick={() => setViewMode('task')}
        title={t('toolbar.taskView')}
        pressed={viewMode === 'task'}
      >
        {t('toolbar.taskView')}
      </ToolbarButton>
      <ToolbarButton
        onClick={() => setViewMode('resource')}
        title={t('toolbar.resourceView')}
        pressed={viewMode === 'resource'}
      >
        {t('toolbar.resourceView')}
      </ToolbarButton>
      <ToolbarButton
        onClick={() => setShowCostColumns(!showCostColumns)}
        title={t('toolbar.effortColumn')}
        pressed={showCostColumns}
      >
        {t('toolbar.effortColumn')}
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
      <div className="ml-auto shrink-0">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <ToolbarButton title="更多操作" aria-label="更多操作">
              <MoreHorizontal size={17} />
            </ToolbarButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-40 min-w-64 rounded-xl border border-border bg-bg-elevated p-2 shadow-xl"
            >
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                导入为新项目
              </div>
              <ImportMenu />
              <DropdownMenu.Separator className="my-2 h-px bg-border" />
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                导出当前项目
              </div>
              <ExportMenu />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
