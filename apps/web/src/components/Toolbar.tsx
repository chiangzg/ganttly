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
 * - Export menu (M4; project imports live in the new-project dialog)
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
import { BaselineControl } from './BaselineControl';
import { findActiveBaseline } from '@/lib/baseline';
import { nanoid } from 'nanoid';
import { addTaskCommand } from '@/store/useProjectStore';
import type { Task } from '@ganttly/schema';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CalendarDays,
  Check,
  CircleAlert,
  Columns3,
  GitBranch,
  ListTree,
  LoaderCircle,
  Minus,
  MoreHorizontal,
  Plus,
  Redo2,
  Save,
  Undo2,
  Users,
  ZoomIn,
} from 'lucide-react';
import { cn } from '@/lib/cn';

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
  const saveState = useProjectStore((s) => s.saveState);
  const openDrawer = useViewStore((s) => s.openDrawer);

  const jumpToToday = () => {
    // Use the SAME origin the renderer uses (assembleScene → originDateFor).
    // The previous code used file.tasks[0]?.start, which diverged from the
    // renderer's min(earliest task, project.startDate ?? '2026-01-05') and so
    // the "today" button landed on the wrong column (e.g. February).
    // Spec §6.5: include the active baseline so Today stays aligned when
    // comparison extends the chart origin to the left.
    const activeBaseline = findActiveBaseline(
      file.baselines,
      useViewStore.getState().activeBaselineId,
    );
    const origin = originDateFor(file, { activeBaseline });
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
      overtimeDates: [],
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
    <div
      data-editor-toolbar
      className="flex h-11 shrink-0 items-center gap-1 overflow-hidden border-b border-border/80 bg-bg-elevated px-2.5"
    >
      <ToolbarGroup aria-label="日期导航">
        <ToolbarButton onClick={jumpToToday} title={t('toolbar.today')}>
          <CalendarDays size={15} />
          <span>{t('toolbar.today')}</span>
        </ToolbarButton>
        <div className="hidden items-center rounded-lg bg-bg p-0.5 lg:flex" aria-label="时间缩放">
          <ToolbarButton
            size="icon"
            onClick={zoomOut}
            title={t('toolbar.zoomOut')}
            aria-label={t('toolbar.zoomOut')}
            className="h-7 w-7"
          >
            <Minus size={14} />
          </ToolbarButton>
          <span className="min-w-[52px] px-1 text-center text-xs font-medium text-fg">
            {t(`toolbar.zoom${cap(file.viewState.zoom)}`)}
          </span>
          <ToolbarButton
            size="icon"
            onClick={zoomIn}
            title={t('toolbar.zoomIn')}
            aria-label={t('toolbar.zoomIn')}
            className="h-7 w-7"
          >
            <Plus size={14} />
          </ToolbarButton>
        </div>
      </ToolbarGroup>

      <ToolbarDivider className="hidden lg:block" />
      <ToolbarGroup className="hidden lg:flex" aria-label="计划显示">
        <div className="hidden xl:block">
          <ToolbarButton
            onClick={toggleCriticalPath}
            title={t('toolbar.criticalPath')}
            aria-label={t('toolbar.criticalPath')}
            pressed={file.viewState.showCriticalPath}
          >
            <GitBranch size={15} />
            {file.viewState.showCriticalPath
              ? t('toolbar.hideCriticalPath')
              : t('toolbar.showCriticalPath')}
          </ToolbarButton>
        </div>
        {viewMode === 'task' ? <BaselineControl /> : null}
      </ToolbarGroup>

      <ToolbarDivider className="hidden lg:block" />
      <ToolbarGroup aria-label="视图">
        <div
          className="flex items-center rounded-lg bg-bg p-0.5"
          role="group"
          aria-label="视图切换"
        >
          <ToolbarButton
            size="compact"
            onClick={() => setViewMode('task')}
            title={t('toolbar.taskView')}
            pressed={viewMode === 'task'}
            className="h-7"
          >
            <ListTree size={14} />
            {t('toolbar.taskView')}
          </ToolbarButton>
          <ToolbarButton
            size="compact"
            onClick={() => setViewMode('resource')}
            title={t('toolbar.resourceView')}
            pressed={viewMode === 'resource'}
            className="h-7"
          >
            <Users size={14} />
            {t('toolbar.resourceView')}
          </ToolbarButton>
        </div>
        <div className="hidden xl:block">
          <ToolbarButton
            onClick={() => setShowCostColumns(!showCostColumns)}
            title={t('toolbar.effortColumn')}
            pressed={showCostColumns}
          >
            <Columns3 size={15} />
            {t('toolbar.effortColumn')}
          </ToolbarButton>
        </div>
      </ToolbarGroup>

      <div className="min-w-1 flex-1" />
      <ToolbarGroup aria-label="编辑操作">
        <ToolbarButton onClick={addRootTask} title={t('toolbar.newTask')} variant="primary">
          <Plus size={15} strokeWidth={2.25} />
          {t('toolbar.newTask')}
        </ToolbarButton>
        <ToolbarButton
          size="icon"
          onClick={undo}
          disabled={!canUndo}
          aria-label={t('toolbar.undo')}
          title={nextUndoLabel ? t('status.undo', { label: nextUndoLabel }) : t('toolbar.undo')}
        >
          <Undo2 size={16} />
        </ToolbarButton>
        <ToolbarButton
          size="icon"
          onClick={redo}
          disabled={!canRedo}
          aria-label={t('toolbar.redo')}
          title={nextRedoLabel ? t('status.redo', { label: nextRedoLabel }) : t('toolbar.redo')}
        >
          <Redo2 size={16} />
        </ToolbarButton>
        <ToolbarButton
          size="icon"
          onClick={() => void save()}
          aria-label={t('toolbar.save')}
          title={saveTitle(saveState, t('toolbar.save'), t('status.saving'), t('status.saved'))}
          className={saveState.status === 'error' ? 'text-danger hover:text-danger' : undefined}
        >
          {saveState.status === 'saving' ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : saveState.status === 'error' ? (
            <CircleAlert size={16} />
          ) : saveState.status === 'saved' ? (
            <Check size={16} />
          ) : (
            <Save size={16} />
          )}
        </ToolbarButton>
      </ToolbarGroup>

      <div className="shrink-0">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <ToolbarButton size="icon" title="更多操作" aria-label="更多操作">
              <MoreHorizontal size={17} />
            </ToolbarButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              forceMount
              align="end"
              sideOffset={6}
              className="z-40 min-w-64 rounded-xl border border-border bg-bg-elevated p-2 shadow-xl data-[state=closed]:hidden"
            >
              <div className="lg:hidden">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                  时间缩放
                </div>
                <DropdownMenu.Item onSelect={zoomIn} className={menuItemClass}>
                  <ZoomIn size={15} className="text-fg-muted" />
                  {t('toolbar.zoomIn')}
                  <span className="ml-auto text-xs text-fg-muted">
                    {t(`toolbar.zoom${cap(file.viewState.zoom)}`)}
                  </span>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={zoomOut} className={menuItemClass}>
                  <Minus size={15} className="text-fg-muted" />
                  {t('toolbar.zoomOut')}
                </DropdownMenu.Item>
                {viewMode === 'task' ? <BaselineControl presentation="menu" /> : null}
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
              </div>
              <div className="xl:hidden">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                  显示选项
                </div>
                <DropdownMenu.CheckboxItem
                  checked={file.viewState.showCriticalPath}
                  onCheckedChange={toggleCriticalPath}
                  className={menuItemClass}
                >
                  <GitBranch size={15} className="text-fg-muted" />
                  {t('toolbar.criticalPath')}
                  <DropdownMenu.ItemIndicator className="ml-auto">
                    <Check size={14} className="text-primary" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.CheckboxItem>
                <DropdownMenu.CheckboxItem
                  checked={showCostColumns}
                  onCheckedChange={() => setShowCostColumns(!showCostColumns)}
                  className={menuItemClass}
                >
                  <Columns3 size={15} className="text-fg-muted" />
                  {t('toolbar.effortColumn')}
                  <DropdownMenu.ItemIndicator className="ml-auto">
                    <Check size={14} className="text-primary" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.CheckboxItem>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
              </div>
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

const menuItemClass =
  'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-bg';

function ToolbarGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('flex shrink-0 items-center gap-1', className)} />;
}

function saveTitle(
  state: { status: string; error?: string },
  saveLabel: string,
  savingLabel: string,
  savedLabel: string,
): string {
  if (state.status === 'saving') return savingLabel;
  if (state.status === 'error') return state.error ? `${saveLabel}：${state.error}` : saveLabel;
  if (state.status === 'saved') return savedLabel;
  return saveLabel;
}
