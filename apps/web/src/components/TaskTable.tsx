/**
 * WBS task table — the left pane (PRD §3.1, §3.10).
 *
 * Features:
 * - Render the task tree (WBS numbers, names, dates, duration, progress)
 * - Click to select, double-click to open the edit drawer
 * - Keyboard: Tab/Shift+Tab indent/outdent, Enter new sibling, Delete, F2 rename
 * - Mouse drag to reorder + reparent (HTML5 DnD)
 * - Right-click for the context menu
 * - Vertical scroll shared with GanttCanvas via projectStore.scrollTop
 */
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  useProjectStore,
  setViewStateCommand,
  moveTaskWithRollupCommand,
  deleteTaskCommand,
  updateTaskCommand,
  swapSiblingOrderCommand,
  pasteTaskCommand,
  type Command,
} from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { buildTree, flattenVisible, type TreeNode } from '@/engine/scene';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';
import { cn } from '@/lib/cn';
import { clipboard, copyToClipboard, cutToClipboard, clearClipboard } from '@/lib/clipboard';
import { computeTaskPersonDays } from '@/lib/cost';
import { computeAllRollups } from '@/lib/summary';
import { resolveCalendar } from '@/lib/calendar';
import {
  findActiveBaseline,
  buildEffectiveValues,
  compareTaskToBaseline,
  type TaskBaselineVariance,
  type EffectiveTaskValue,
} from '@/lib/baseline';
import { deviationColumnCell, deviationToneClass } from './BaselineVariance';
import * as Tooltip from '@radix-ui/react-tooltip';
import { nanoid } from 'nanoid';
import type { Task, BaselineTask } from '@ganttly/schema';

const TABLE_WIDTH = 420;
const TABLE_WIDTH_WITH_EFFORT = 480;
const TABLE_WIDTH_WITH_BASELINE = 492;
const TABLE_WIDTH_WITH_EFFORT_AND_BASELINE = 552;
/**
 * 共享列模板：表头与每行数据必须用同一个，否则列宽按行内容自适应，
 * 会导致 WBS/工期/进度列与表头错位、长任务名挤压（bug: 左侧明细挤在一起）。
 * 基线偏差列（baseline-comparison spec §5.6）仅在比较模式开启时追加 70px。
 */
const GRID_TEMPLATE = '44px minmax(0, 1fr) 72px 64px';
const GRID_TEMPLATE_WITH_EFFORT = '44px minmax(0, 1fr) 72px 56px 56px';
const GRID_TEMPLATE_WITH_BASELINE = '44px minmax(0, 1fr) 72px 64px 70px';
const GRID_TEMPLATE_WITH_EFFORT_AND_BASELINE = '44px minmax(0, 1fr) 72px 56px 56px 70px';

export function TaskTable() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const openContextMenu = useViewStore((s) => s.openContextMenu);
  const showCostColumns = useViewStore((s) => s.showCostColumns);
  const activeBaselineId = useViewStore((s) => s.activeBaselineId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const renamingId = useRef<string | null>(null);

  const activeBaseline = findActiveBaseline(file.baselines, activeBaselineId);
  const hasBaseline = activeBaseline !== null;

  const gridTemplate = showCostColumns
    ? hasBaseline
      ? GRID_TEMPLATE_WITH_EFFORT_AND_BASELINE
      : GRID_TEMPLATE_WITH_EFFORT
    : hasBaseline
      ? GRID_TEMPLATE_WITH_BASELINE
      : GRID_TEMPLATE;
  const tableWidth = showCostColumns
    ? hasBaseline
      ? TABLE_WIDTH_WITH_EFFORT_AND_BASELINE
      : TABLE_WIDTH_WITH_EFFORT
    : hasBaseline
      ? TABLE_WIDTH_WITH_BASELINE
      : TABLE_WIDTH;
  const cal = useMemo(() => resolveCalendar(file.calendar), [file.calendar]);

  const rows = useMemo(() => {
    const tree = buildTree(file.tasks);
    return flattenVisible(tree, new Set(file.viewState.collapsedTaskIds));
  }, [file.tasks, file.viewState.collapsedTaskIds]);

  // Person-days rollup map (summary tasks use rolled-up children sum, G13).
  const effortMap = useMemo(
    () => computeAllRollups(file.tasks, file.resources, cal),
    [file.tasks, file.resources, cal],
  );

  // Baseline comparison: effective current values (summary rollup applied) +
  // snapshot-by-id map, both built ONCE. Each row looks up its variance in
  // O(1) (spec §9.4 — no nested find in the render loop).
  const baselineCtx = useMemo(() => {
    if (!activeBaseline) return null;
    const effective = buildEffectiveValues(file, cal);
    const byId = new Map(activeBaseline.tasks.map((bt) => [bt.id, bt]));
    return { effective, byId };
  }, [activeBaseline, file.tasks, file.resources, cal]);

  // Latest scrollTop kept in a ref so the store→DOM sync effect can decide
  // whether the change originated here (user scrolling) or elsewhere (canvas
  // wheel-pan / Today button) without re-binding.
  const localScrolling = useRef(false);

  // Reflect store-driven scrollTop changes (from canvas wheel-pan) onto this
  // panel. When the user scrolls here directly, onScroll updates the store and
  // sets localScrolling so this effect becomes a no-op for that frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || localScrolling.current) return;
    if (Math.abs(el.scrollTop - file.viewState.scrollTop) > 1) {
      el.scrollTop = file.viewState.scrollTop;
    }
  }, [file.viewState.scrollTop]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    localScrolling.current = true;
    if (top !== file.viewState.scrollTop) {
      // Direct setState, not dispatch — scrolling is ephemeral and must not
      // pollute the undo stack with one "视图变更" per scroll tick.
      useProjectStore.setState({
        file: {
          ...file,
          viewState: { ...file.viewState, scrollTop: top },
        },
      });
    }
    requestAnimationFrame(() => {
      localScrolling.current = false;
    });
  };

  const select = (taskId: string) => {
    dispatch(setViewStateCommand({ selectedTaskId: taskId }));
  };

  const toggleCollapse = (taskId: string) => {
    const ids = file.viewState.collapsedTaskIds;
    const next = ids.includes(taskId) ? ids.filter((id) => id !== taskId) : [...ids, taskId];
    dispatch(setViewStateCommand({ collapsedTaskIds: next }));
  };

  // ---- Keyboard navigation (PRD §3.10) ----
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, node: TreeNode) => {
    const task = node.task;

    // Clipboard (Ctrl/Cmd+C / X / V).
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        copyToClipboard(task);
        return;
      }
      if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        cutToClipboard(task);
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        const src = clipboard.task;
        if (!src) return;
        // Deep-copy with a fresh id; drop dependencies (they reference old ids).
        const pasted: Task = {
          ...src,
          id: nanoid(10),
          name: `${src.name} ${t('table.copySuffix')}`.trim(),
          dependencies: [],
        };
        if (clipboard.cutMode) {
          // Cut = move: delete source then insert at anchor.
          dispatch(deleteTaskCommand(src.id));
          clearClipboard();
        }
        dispatch(pasteTaskCommand(pasted, task.id));
        return;
      }
      // Fall through: don't hijack Ctrl+S, Ctrl+Z, etc.
    }

    // Alt+Up/Down: reorder within siblings (PRD §3.10).
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveSibling(task.id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      dispatch(setViewStateCommand({ selectedTaskId: null }));
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      indentOrOutdent(task.id, e.shiftKey);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      createSibling(task.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (window.confirm(t('table.confirmDelete'))) {
        dispatch(deleteTaskCommand(task.id));
      }
    } else if (e.key === 'F2') {
      e.preventDefault();
      renamingId.current = task.id;
      // Force re-render so the row shows an input.
      forceRerender();
    }
  };

  /** Swap a task with its previous (-1) or next (+1) sibling by order. */
  const moveSibling = (taskId: string, dir: -1 | 1) => {
    const me = file.tasks.find((t) => t.id === taskId);
    if (!me) return;
    const siblings = file.tasks
      .filter((t) => t.parentId === me.parentId)
      .sort((a, b) => a.order - b.order);
    const idx = siblings.findIndex((t) => t.id === taskId);
    const swapWith = siblings[idx + dir];
    if (!swapWith) return; // already at the edge
    dispatch(swapSiblingOrderCommand(taskId, swapWith.id));
  };

  // We need a tiny rerender trigger for inline rename.
  const [, setRerender] = useState(0);
  const forceRerender = () => setRerender((n) => n + 1);

  const indentOrOutdent = (taskId: string, outdent: boolean) => {
    const tasks = file.tasks;
    const me = tasks.find((t) => t.id === taskId);
    if (!me) return;
    const siblings = tasks
      .filter((t) => t.parentId === me.parentId)
      .sort((a, b) => a.order - b.order);
    const myIdx = siblings.findIndex((t) => t.id === taskId);
    if (outdent) {
      // Become sibling of parent.
      if (me.parentId === null) return;
      const parent = tasks.find((t) => t.id === me.parentId);
      if (!parent) return;
      const newParentId = parent.parentId;
      const newOrder = parent.order + 1;
      dispatch(moveTaskWithRollupCommand(taskId, newParentId, newOrder));
    } else {
      // Indent: become child of previous sibling.
      if (myIdx === null || myIdx <= 0) return;
      const prev = siblings[myIdx - 1]!;
      dispatch(moveTaskWithRollupCommand(taskId, prev.id, countChildren(prev.id, tasks)));
    }
  };

  const createSibling = (taskId: string) => {
    const tasks = file.tasks;
    const me = tasks.find((t) => t.id === taskId);
    if (!me) return;
    const id = nanoid(10);
    const start = me.start;
    const newTask: Task = {
      id,
      name: t('table.placeholderName'),
      parentId: me.parentId,
      order: me.order + 1,
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
    // Bump order of all later siblings so the new task slots in.
    const reorder: Command = {
      label: `新增同级任务`,
      apply: (file) => {
        const siblings = file.tasks.filter((x) => x.parentId === me.parentId && x.order > me.order);
        const bumped = file.tasks.map((x) =>
          siblings.some((s) => s.id === x.id) ? { ...x, order: x.order + 1 } : x,
        );
        return { ...file, tasks: [...bumped, newTask] };
      },
      invert: (file) => ({ ...file, tasks: file.tasks.filter((x) => x.id !== id) }),
    };
    dispatch(reorder);
    dispatch(setViewStateCommand({ selectedTaskId: id }));
    renamingId.current = id;
    forceRerender();
  };

  // ---- Drag & drop reorder / reparent (PRD §3.10) ----
  const onDragStart = (e: React.DragEvent<HTMLDivElement>, node: TreeNode) => {
    e.dataTransfer.setData('text/plain', node.task.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>, target: TreeNode) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === target.task.id) return;
    // Can't drop onto own descendant.
    if (target.ancestorIds.includes(draggedId)) return;
    // Place as last child of target (drop "into" target).
    dispatch(
      moveTaskWithRollupCommand(
        draggedId,
        target.task.id,
        countChildren(target.task.id, file.tasks),
      ),
    );
  };

  return (
    <div
      data-task-table
      className="flex shrink-0 flex-col border-r border-border bg-bg-elevated"
      style={{ width: tableWidth }}
    >
      <div
        className="grid border-b border-border bg-bg-elevated text-xs font-semibold text-fg-muted"
        style={{ height: HEADER_HEIGHT, gridTemplateColumns: gridTemplate }}
      >
        <div className="border-r border-border px-2 py-1">{t('table.columnWbs')}</div>
        <div className="border-r border-border px-2 py-1">{t('table.columnName')}</div>
        <div className="border-r border-border px-2 py-1">{t('table.columnDuration')}</div>
        {showCostColumns && (
          <div className="border-r border-border px-2 py-1">{t('table.columnEffort')}</div>
        )}
        <div className="border-r border-border px-2 py-1">{t('table.columnProgress')}</div>
        {hasBaseline && <div className="px-2 py-1">{t('baseline.columnDeviation')}</div>}
      </div>
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto" onScroll={onScroll}>
        <div className="relative" style={{ height: Math.max(rows.length * ROW_HEIGHT, 0) }}>
          {rows.map((node, i) => {
            const y = i * ROW_HEIGHT;
            const selected = file.viewState.selectedTaskId === node.task.id;
            const isRenaming = renamingId.current === node.task.id;
            return (
              <div
                key={node.task.id}
                role="row"
                tabIndex={0}
                draggable
                onDragStart={(e) => onDragStart(e, node)}
                onDrop={(e) => onDrop(e, node)}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => select(node.task.id)}
                onDoubleClick={() => {
                  select(node.task.id);
                  openDrawer();
                }}
                onKeyDown={(e) => onKeyDown(e, node)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  select(node.task.id);
                  openContextMenu(node.task.id, e.clientX, e.clientY);
                }}
                onBlur={() => {
                  if (isRenaming) {
                    renamingId.current = null;
                    forceRerender();
                  }
                }}
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${y}px)`,
                  gridTemplateColumns: gridTemplate,
                }}
                className={cn(
                  'absolute left-0 right-0 grid cursor-pointer items-center border-b border-border text-xs outline-none',
                  'hover:bg-bg',
                  selected && 'bg-bg ring-1 ring-inset ring-primary',
                  node.children.length > 0 && 'bg-bg-elevated',
                )}
              >
                <div
                  className={cn(
                    'flex items-center overflow-hidden border-r border-border px-2 text-fg-muted',
                    node.children.length > 0 && 'font-semibold',
                  )}
                  style={{ paddingLeft: 8 + node.depth * 16 }}
                >
                  {node.children.length > 0 && (
                    <button
                      type="button"
                      className="mr-1 inline-flex shrink-0 items-center justify-center text-[10px] text-fg-muted hover:text-fg"
                      style={{ width: 14, height: 14 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapse(node.task.id);
                      }}
                    >
                      {file.viewState.collapsedTaskIds.includes(node.task.id) ? '▶' : '▼'}
                    </button>
                  )}
                  {node.wbsNumber}
                </div>
                <div
                  className={cn(
                    'min-w-0 truncate border-r border-border px-2 font-medium',
                    node.children.length > 0 && 'font-semibold',
                  )}
                >
                  {node.task.isMilestone && <span className="mr-1 text-warning">◆</span>}
                  {isRenaming ? (
                    <input
                      autoFocus
                      defaultValue={node.task.name}
                      onBlur={(e) => {
                        dispatch(updateTaskCommand(node.task.id, { name: e.target.value }));
                        renamingId.current = null;
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') {
                          if (e.key === 'Enter') {
                            dispatch(
                              updateTaskCommand(node.task.id, {
                                name: (e.target as HTMLInputElement).value,
                              }),
                            );
                          }
                          renamingId.current = null;
                          forceRerender();
                        }
                      }}
                      className="w-full bg-transparent outline-none"
                    />
                  ) : (
                    node.task.name || t('table.placeholderName')
                  )}
                </div>
                <div className="border-r border-border px-2 text-right tabular-nums text-fg-muted">
                  {node.task.isMilestone ? '—' : `${node.task.duration}d`}
                </div>
                {showCostColumns && (
                  <div className="border-r border-border px-2 text-right tabular-nums text-fg-muted">
                    {(() => {
                      const pd =
                        node.children.length > 0
                          ? effortMap.get(node.task.id)?.personDays
                          : computeTaskPersonDays(node.task, file.resources, cal);
                      return pd && pd > 0 ? `${pd}` : '—';
                    })()}
                  </div>
                )}
                <div className="border-r border-border px-2 text-right tabular-nums text-fg-muted">
                  {node.task.progress}%
                </div>
                {hasBaseline && baselineCtx ? (
                  <BaselineDeviationCell
                    taskId={node.task.id}
                    baselineCtx={baselineCtx}
                    cal={cal}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function countChildren(parentId: string, tasks: ReadonlyArray<Task>): number {
  return tasks.filter((t) => t.parentId === parentId).length;
}

/**
 * Deviation cell for the TaskTable (baseline-comparison spec §5.6).
 *
 * Shows the finish-deviation summary (`+3 天`, `−2 天`, `—`, `新增`) with the
 * right tone. Hovering/focusing reveals a Radix Tooltip with the full start /
 * finish / duration breakdown so the Canvas isn't the only place to read it.
 */
function BaselineDeviationCell({
  taskId,
  baselineCtx,
  cal,
}: {
  taskId: string;
  baselineCtx: { effective: Map<string, EffectiveTaskValue>; byId: Map<string, BaselineTask> };
  cal: ReturnType<typeof resolveCalendar>;
}) {
  const eff = baselineCtx.effective.get(taskId);
  if (!eff) return <div className="px-2 text-right tabular-nums text-fg-muted">—</div>;
  const variance = compareTaskToBaseline(eff, baselineCtx.byId.get(taskId), cal);
  const cell = deviationColumnCell(variance);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <div
          tabIndex={0}
          className={cn(
            'cursor-help px-2 text-right text-xs font-medium tabular-nums outline-none',
            deviationToneClass(cell.tone),
          )}
        >
          {cell.text}
        </div>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={4}
          className="z-50 rounded-lg border border-border bg-bg-elevated px-2.5 py-2 text-xs text-fg shadow-lg"
        >
          <DeviationDetail variance={variance} />
          <Tooltip.Arrow className="fill-border" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Compact deviation detail block, reused by the table tooltip. */
function DeviationDetail({ variance }: { variance: TaskBaselineVariance }) {
  const { t } = useTranslation();
  if (variance.status === 'added') {
    return <div className="font-medium">{t('baseline.deviationAdded')}</div>;
  }
  return (
    <table className="border-collapse">
      <tbody>
        <tr>
          <td className="pr-3 text-fg-muted">{t('baseline.varianceStart')}</td>
          <td className="tabular-nums">{formatSigned(variance.startDelta)}</td>
        </tr>
        <tr>
          <td className="pr-3 text-fg-muted">{t('baseline.varianceFinish')}</td>
          <td className="tabular-nums font-medium">{formatSigned(variance.finishDelta)}</td>
        </tr>
        <tr>
          <td className="pr-3 text-fg-muted">{t('baseline.varianceDuration')}</td>
          <td className="tabular-nums">{formatSigned(variance.durationDelta)}</td>
        </tr>
      </tbody>
    </table>
  );
}

const MINUS_CH = '\u2212';
function formatSigned(n: number): string {
  if (n > 0) return `+${n} 天`;
  if (n < 0) return `${MINUS_CH}${Math.abs(n)} 天`;
  return '0';
}
