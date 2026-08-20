/**
 * WBS task table — the left pane (PRD §3.1, §3.10).
 *
 * Features:
 * - Render the task tree (flat WBS numbers + tree affordances in the name cell)
 * - Click to select, double-click ANYWHERE on the row to open the edit drawer
 * - Inline edit via F2 (+ Tab traversal); rename also from the context menu
 * - Keyboard: arrows navigate/collapse, Tab indents, Enter adds, Delete removes, F2 renames
 * - Drag reordering starts ONLY from the grip slot (HTML5 DnD); the row itself
 *   is not draggable, so clicks never become accidental drags
 * - Right-click for the context menu; expand/collapse-all in the search bar
 * - Vertical scroll shared with GanttCanvas via projectStore.scrollTop
 */
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { TFunction } from 'i18next';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  GripVertical,
  Plus,
  Search,
  X,
} from 'lucide-react';
import {
  useProjectStore,
  setViewStateCommand,
  moveTaskWithRollupCommand,
  deleteTaskCommand,
  updateTaskCommand,
  updateTaskFromDraftCommand,
  swapSiblingOrderCommand,
  pasteTaskCommand,
  type Command,
} from '@/store/useProjectStore';
import { computeSelectionOnPointerDown } from '@/lib/selection';
import { createRootTask } from '@/lib/createTask';
import { EmptyState } from './ui/EmptyState';
import { useViewStore } from '@/store/useViewStore';
import { buildTree, flattenVisible, type TreeNode } from '@/engine/scene';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';
import { cn } from '@/lib/cn';
import { computeFilteredRows, isAnyFilterActive } from '@/lib/taskFilter';
import { endDateFromDuration } from '@/lib/calendar';
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
import { computeDropPosition, resolveDropTarget, type TaskDropTarget } from '@/lib/taskDropTarget';
import { isEditableTarget } from '@/lib/shortcutTarget';
import { nanoid } from 'nanoid';
import type { Task, BaselineTask } from '@ganttly/schema';
import { DeleteTaskConfirm } from './DeleteTaskConfirm';
import { BatchDeleteConfirm } from './BatchDeleteConfirm';
import { usePanelWidth, useColumnWidths } from './useLayoutPrefs';
import { ResizeHandle, ResizableHeaderCell, startPointerResize } from './ui/ResizeHandle';
import { DEFAULT_PANEL_WIDTHS, DEFAULT_COLUMN_WIDTHS } from '@/lib/layoutPrefs';
import { adjacentSelectableRow, focusAndRevealRow } from '@/lib/rowKeyboardNavigation';

const TABLE_WIDTH = 480;
const TABLE_WIDTH_WITH_BASELINE = 552;
/** Keep task controls within the canvas's shared two-row header height. */
const TASK_SEARCH_HEIGHT = 36;
/** §4.1: the baseline comparison mode appends this many px to the user's panel
 * width (default 480→552, unchanged from pre-§4.1); the deviation COLUMN width
 * itself is separately adjustable via the header separator. */
const BASELINE_PANEL_EXTRA = TABLE_WIDTH_WITH_BASELINE - TABLE_WIDTH;
/**
 * 共享列模板：表头与每行数据必须用同一个，否则列宽按行内容自适应，
 * 会导致 WBS/工期/进度列与表头错位、长任务名挤压（bug: 左侧明细挤在一起）。
 * “人天”列（56px）恒驻于工期与进度之间；基线偏差列（baseline-comparison spec
 * §5.6）仅在比较模式开启时追加。
 * §4.1: 除任务名列（minmax(0,1fr) 弹性吸收）外，其余列宽来自
 * useColumnWidths 状态，模板由组件按状态计算，表头与行引用同一值。
 */

/**
 * The three task-table cells that support inline editing (plan §4.3). Order
 * matters: it defines the Tab-traversal sequence within a row.
 */
type EditableField = 'name' | 'duration' | 'progress';
const EDITABLE_FIELDS: readonly EditableField[] = ['name', 'duration', 'progress'] as const;

/**
 * Compact single-line filter toggle for the §4.4 search bar. Renders as a small
 * pill that shows a pressed state when active. Mutually exclusive with the
 * other filters (selecting one clears the rest — handled by the parent).
 *
 * The accessible name is prefixed with "筛选" so it is distinct from same-named
 * toolbar controls (e.g. the toolbar "关键路径" critical-path toggle) — without
 * this, `getByRole('button', { name: '关键路径' })` would match both.
 */
function FilterToggle({
  active,
  onClick,
  label,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      title={label}
      className={cn(
        'h-7 shrink-0 whitespace-nowrap rounded-md px-1.5 text-[11px] font-medium outline-none transition',
        'focus-visible:ring-2 focus-visible:ring-primary/35',
        active
          ? 'bg-primary/10 text-primary hover:bg-primary/15'
          : 'text-fg-muted hover:bg-bg hover:text-fg',
      )}
    >
      {label}
    </button>
  );
}

export function TaskTable() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const openContextMenu = useViewStore((s) => s.openContextMenu);
  const activeBaselineId = useViewStore((s) => s.activeBaselineId);
  // §4.4 search/filter — ephemeral view state, never in the undo stack.
  const searchQuery = useViewStore((s) => s.searchQuery);
  const taskFilter = useViewStore((s) => s.taskFilter);
  const setSearchQuery = useViewStore((s) => s.setSearchQuery);
  const setTaskFilter = useViewStore((s) => s.setTaskFilter);
  // §4.6 multi-select — ephemeral (plan §9.1: selection is NOT in the undo
  // stack). Subscribed at row-render granularity so Cmd/Ctrl+Click and
  // Shift+Click update highlights immediately.
  const selectedTaskIds = useViewStore((s) => s.selectedTaskIds);
  const anchorTaskId = useViewStore((s) => s.anchorTaskId);
  const selectSingle = useViewStore((s) => s.selectSingle);
  const clearSelection = useViewStore((s) => s.clearSelection);
  // §4.6: the GanttCanvas has no confirm dialog of its own, so on canvas
  // Delete-with-multi-select it bumps this counter; we open BatchDeleteConfirm.
  const batchDeleteSignal = useViewStore((s) => s.batchDeleteSignal);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Which cell is in inline-edit mode (plan §4.3). `name` is the existing F2
  // rename; `duration`/`progress` are new. A ref + forceRerender keeps the
  // editing input uncontrolled, matching the original F2 pattern.
  const editingCell = useRef<{ taskId: string; field: EditableField } | null>(null);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);
  // §4.6 batch-delete confirm — opened with the multi-select id list when the
  // user presses Delete/Backspace while more than one task is selected.
  const [batchDeleteIds, setBatchDeleteIds] = useState<string[] | null>(null);
  // §4.6: react to the canvas's batch-delete signal by opening the confirm
  // dialog for the current multi-selection. Skips the initial 0 (no request).
  useEffect(() => {
    if (batchDeleteSignal === 0) return;
    const ids = [...useViewStore.getState().selectedTaskIds];
    if (ids.length > 1) setBatchDeleteIds(ids);
  }, [batchDeleteSignal]);

  // ---- Drag & drop reorder / reparent (plan §2.3) ----
  // Ephemeral UI state: never written to the store or the undo stack.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskDropTarget | null>(null);
  // Escape cancels an in-flight drag (plan §2.3). Tracked via ref because the
  // window keydown listener lives outside React's render cycle.
  const dragCancelled = useRef(false);
  const autoScrollRaf = useRef<number | null>(null);

  const activeBaseline = findActiveBaseline(file.baselines, activeBaselineId);
  const hasBaseline = activeBaseline !== null;

  // §4.1: panel + column widths are per-project user preferences (localStorage,
  // never in the project file or the undo stack). The name column stays
  // `minmax(0, 1fr)` and absorbs every width delta, so the grid never shows
  // empty space at any panel width.
  const [panelWidth, setPanelWidth] = usePanelWidth('task');
  const { widths: colWidths, setColumnWidth } = useColumnWidths('task');

  // §4.1: per-column widths (name column stays flexible). Fallbacks keep the
  // template valid even before the persisted widths load.
  const durationWidth = colWidths.duration ?? DEFAULT_COLUMN_WIDTHS.duration;
  const effortWidth = colWidths.effort ?? DEFAULT_COLUMN_WIDTHS.effort;
  const progressWidth = colWidths.progress ?? DEFAULT_COLUMN_WIDTHS.progress;
  const baselineWidth = colWidths.baseline ?? DEFAULT_COLUMN_WIDTHS.baseline;

  const tableWidth = panelWidth + (hasBaseline ? BASELINE_PANEL_EXTRA : 0);
  const cal = useMemo(() => resolveCalendar(file.calendar), [file.calendar]);

  const rows = useMemo(() => {
    // §4.4: when a search/filter is active, project the rows through the filter
    // (matched leaves + ancestor context, collapsed ancestors force-expanded).
    // When nothing is active, fall back to the plain flattenVisible path so
    // behaviour is identical to pre-§4.4 (zero regression).
    if (isAnyFilterActive(searchQuery, taskFilter)) {
      return computeFilteredRows(file, searchQuery, taskFilter).rows;
    }
    const tree = buildTree(file.tasks);
    return flattenVisible(tree, new Set(file.viewState.collapsedTaskIds));
  }, [file.tasks, file.calendar, file.viewState.collapsedTaskIds, searchQuery, taskFilter]);

  // The WBS cell is a flat "row number" track: [grip slot 18px][number]. The
  // number starts at the same x on every row regardless of depth (the tree
  // structure lives in the NAME cell), so the column reads like spreadsheet
  // row numbers. Width = fixed slots + the longest visible number — no
  // clipping, no depth-dependent growth.
  const wbsWidth = useMemo(() => {
    const minWidth = 44;
    const gripSlot = 18;
    const leftGap = 6;
    const charWidth = 8;
    const rightPadding = 8;
    return rows.reduce((max, node) => {
      const numberWidth = Math.max(1, node.wbsNumber.length) * charWidth;
      return Math.max(max, gripSlot + leftGap + numberWidth + rightPadding);
    }, minWidth);
  }, [rows]);

  // Single computed template shared by the header and every row (the historic
  // misalignment bug was two divergent templates — keep it one source).
  const gridTemplate = [
    `${wbsWidth}px minmax(0, 1fr)`,
    `${durationWidth}px`,
    `${effortWidth}px`,
    `${progressWidth}px`,
    ...(hasBaseline ? [`${baselineWidth}px`] : []),
  ].join(' ');

  // §4.6: the visible row id sequence drives Shift+Click range selection. It
  // must reflect the CURRENT rendered list (post-collapse, post-filter) so the
  // range stays correct when rows are hidden (plan §4.6 验收 "多选在折叠、
  // 筛选和滚动后保持一致").
  const visibleRowIds = useMemo(() => rows.map((n) => n.task.id), [rows]);
  const visibleRowIndexes = useMemo(() => rows.map((_, index) => index), [rows]);

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

  /**
   * Handle a row pointer-down selection, honouring modifier keys (plan §4.6):
   *   - plain click  → selectSingle
   *   - Ctrl/Cmd     → toggleSelected
   *   - Shift        → selectRange (anchor → clicked row, over visible rows)
   * Writes go through useViewStore (ephemeral, never the undo stack — §9.1).
   * The anchor is mirrored into file.viewState.selectedTaskId inside the store.
   */
  const select = (
    taskId: string,
    e?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => {
    if (!e) {
      selectSingle(taskId);
      return;
    }
    const cur = useViewStore.getState();
    const next = computeSelectionOnPointerDown(
      taskId,
      { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey },
      { ids: cur.selectedTaskIds, anchor: cur.anchorTaskId },
      visibleRowIds,
    );
    useViewStore.getState().setSelection(next);
  };

  const toggleCollapse = (taskId: string) => {
    const ids = file.viewState.collapsedTaskIds;
    const next = ids.includes(taskId) ? ids.filter((id) => id !== taskId) : [...ids, taskId];
    dispatch(setViewStateCommand({ collapsedTaskIds: next }));
  };

  const selectAndFocusTaskRow = (rowIndex: number) => {
    const target = rows[rowIndex];
    if (!target) return;
    selectSingle(target.task.id);
    focusAndRevealRow(scrollRef.current, rowIndex, ROW_HEIGHT);
  };

  // ---- Keyboard navigation (PRD §3.10) ----
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, node: TreeNode) => {
    const task = node.task;

    // An inline-edit input (F2 rename, duration/progress editor) has the focus:
    // let it handle its own keys. Without this, Delete/Enter/F2 would bubble
    // out of the input and mis-trigger task ops (plan §4.2 — "输入任务名称时
    // Delete 不误删任务").
    if (isEditableTarget(e.target)) return;

    // §4.6: when multiple tasks are selected, Escape clears the whole set and
    // Delete/Backspace opens the batch-delete confirm. Single-selection (the
    // historical behaviour) falls through to the per-row handlers below.
    const sel = useViewStore.getState();
    if (sel.selectedTaskIds.size > 1) {
      if (e.key === 'Escape') {
        e.preventDefault();
        clearSelection();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        setBatchDeleteIds([...sel.selectedTaskIds]);
        return;
      }
    }

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

    if (
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown')
    ) {
      e.preventDefault();
      const currentIndex = rows.findIndex((row) => row.task.id === task.id);
      const nextIndex = adjacentSelectableRow(
        currentIndex,
        visibleRowIndexes,
        e.key === 'ArrowUp' ? -1 : 1,
      );
      if (nextIndex === null) return;
      selectAndFocusTaskRow(nextIndex);
      return;
    }

    if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowRight') {
      // 流式展开：与 ArrowLeft（流式收起）对称。当前行折叠就展开它；
      // 否则向下找第一个"折叠且有子任务"的可见行展开，避免在叶子或已
      // 展开节点上卡住（按住 → 一口气展开整棵子树）。焦点停在刚展开的
      // 那行。整棵树都已展开时什么都不做——行间导航交给 ↑/↓。
      const collapsedIds = file.viewState.collapsedTaskIds;
      const isCollapsed = (row: TreeNode): boolean =>
        row.children.length > 0 && collapsedIds.includes(row.task.id);
      const currentIndex = rows.findIndex((row) => row.task.id === task.id);
      const current = currentIndex === -1 ? null : (rows[currentIndex] ?? null);
      if (!current) return;
      // 找到展开目标：当前行折叠就用它，否则向下找第一个折叠的行。
      let target = isCollapsed(current) ? current : null;
      for (let i = currentIndex + 1; !target && i < rows.length; i++) {
        const candidate = rows[i];
        if (candidate && isCollapsed(candidate)) target = candidate;
      }
      if (!target) return;

      const targetIndex = rows.indexOf(target);
      e.preventDefault();
      selectAndFocusTaskRow(targetIndex);
      toggleCollapse(target.task.id);
      return;
    }

    if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowLeft') {
      // 流式收起：当前行没有可收起的子树时，继续向上找第一个"已展开
      // 且有子任务"的可见行收起它，避免在叶子或已折叠节点上卡住（按住
      // ← 一口气收起整棵子树）。焦点停在最终被收起的那一行。
      const collapsedIds = file.viewState.collapsedTaskIds;
      const isExpanded = (row: TreeNode): boolean =>
        row.children.length > 0 && !collapsedIds.includes(row.task.id);
      const currentIndex = rows.findIndex((row) => row.task.id === task.id);
      const current = currentIndex === -1 ? null : (rows[currentIndex] ?? null);
      if (!current) return;
      // 找到收起目标：当前行已展开就用它，否则向上找第一个已展开的行。
      let target = isExpanded(current) ? current : null;
      for (let i = currentIndex - 1; !target && i >= 0; i--) {
        const candidate = rows[i];
        if (candidate && isExpanded(candidate)) target = candidate;
      }
      if (!target) return;

      const targetIndex = rows.indexOf(target);
      e.preventDefault();
      selectAndFocusTaskRow(targetIndex);
      toggleCollapse(target.task.id);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      // §4.6: selection lives in useViewStore now (ephemeral, not undoable).
      clearSelection();
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
      setConfirmDeleteTaskId(task.id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      editingCell.current = { taskId: task.id, field: 'name' };
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

  // ---- Inline cell editing (plan §4.3) ----
  /** Whether a given field is editable for this row (summary/milestone rules). */
  const isFieldEditable = (node: TreeNode, field: EditableField): boolean => {
    const isSummary = node.children.length > 0;
    if (field === 'name') return true;
    if (field === 'progress') return !isSummary; // summary progress is rolled up
    // duration: summary rolls up; milestone has no duration.
    return !isSummary && !node.task.isMilestone;
  };

  /** Begin editing a cell (called on double-click of an editable cell). */
  const startEditing = (taskId: string, field: EditableField) => {
    editingCell.current = { taskId, field };
    forceRerender();
  };

  /** Exit editing without changing which task is selected. */
  const stopEditing = () => {
    editingCell.current = null;
    forceRerender();
  };

  /**
   * Commit a name edit. Uses `updateTaskCommand` (no scheduling side-effects),
   * matching the original F2 behaviour.
   */
  const commitName = (taskId: string, value: string) => {
    dispatch(updateTaskCommand(taskId, { name: value }));
  };

  /**
   * Commit a duration edit. Uses `updateTaskFromDraftCommand` so `end` is
   * recomputed, overtime dates are clipped to the new range, and rollup +
   * successor cascade land in a single undo record — exactly like the drawer
   * (plan §4.3 "日期/工期变化继续走 rollup 和级联路径").
   */
  const commitDuration = (taskId: string, raw: number) => {
    const before = file.tasks.find((t) => t.id === taskId);
    if (!before) return;
    const duration = Math.max(0, Math.round(Number.isFinite(raw) ? raw : 0));
    const end = endDateFromDuration(before.start, duration || 1, cal);
    const overtimeDates = (before.overtimeDates ?? []).filter((d) => d >= before.start && d <= end);
    dispatch(updateTaskFromDraftCommand(before, { ...before, duration, end, overtimeDates }));
  };

  /**
   * Commit a progress edit. Clamps to [0,100] and goes through the draft
   * command for a single undo record.
   */
  const commitProgress = (taskId: string, raw: number) => {
    const before = file.tasks.find((t) => t.id === taskId);
    if (!before) return;
    const progress = Math.max(0, Math.min(100, Math.round(Number.isFinite(raw) ? raw : 0)));
    if (progress === before.progress) return;
    dispatch(updateTaskFromDraftCommand(before, { ...before, progress }));
  };

  /**
   * Tab traversal: commit the current cell, then move to the next/previous
   * editable field in the same row (name → duration → progress). Returns true
   * if the focus moved (so the caller can avoid falling back to indent).
   */
  const tabCell = (taskId: string, field: EditableField, reverse: boolean, node: TreeNode) => {
    const idx = EDITABLE_FIELDS.indexOf(field);
    const step = reverse ? -1 : 1;
    let next = idx + step;
    while (next >= 0 && next < EDITABLE_FIELDS.length) {
      const candidate = EDITABLE_FIELDS[next]!;
      if (isFieldEditable(node, candidate)) {
        editingCell.current = { taskId, field: candidate };
        forceRerender();
        return true;
      }
      next += step;
    }
    // Ran off the end: finish editing, let focus return to the row.
    stopEditing();
    return false;
  };

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
    // §4.6: select the freshly created sibling (ephemeral, not undoable).
    selectSingle(id);
    editingCell.current = { taskId: id, field: 'name' };
    forceRerender();
  };

  // ---- Drag & drop reorder / reparent (plan §2.3) ----
  // The drag preview is pure local React state; the only thing that hits the
  // undo stack is the final `onDrop` dispatch (plan §9.1 — no per-move commands).
  const onDragStart = (e: React.DragEvent<HTMLDivElement>, node: TreeNode) => {
    e.dataTransfer.setData('text/plain', node.task.id);
    e.dataTransfer.effectAllowed = 'move';
    // A transparent drag image lets us show our own insertion-line feedback
    // instead of the browser's faded row ghost.
    dragCancelled.current = false;
    setDraggedId(node.task.id);
    // Escape listener: attached for the lifetime of this drag. Uses the DOM
    // KeyboardEvent (window-level), distinct from React's synthetic one.
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        dragCancelled.current = true;
        setDropTarget(null);
        setDraggedId(null);
      }
    };
    dragEscapeHandler.current = onEsc;
    window.addEventListener('keydown', onEsc);
  };

  // Holds the active window keydown handler so onDrop/onDragEnd can remove it.
  const dragEscapeHandler = useRef<((e: globalThis.KeyboardEvent) => void) | null>(null);

  const onDragOver = (e: React.DragEvent<HTMLDivElement>, node: TreeNode) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = dragCancelled.current ? 'none' : 'move';
    if (!draggedId || dragCancelled.current) return;
    const row = e.currentTarget;
    const rect = row.getBoundingClientRect();
    const offset = e.clientY - rect.top;
    const position = computeDropPosition(offset, ROW_HEIGHT);
    const next = resolveDropTarget(draggedId, node.task.id, position, file.tasks);
    setDropTarget((prev) =>
      prev &&
      prev.taskId === next.taskId &&
      prev.position === next.position &&
      prev.parentId === next.parentId &&
      prev.order === next.order &&
      prev.invalid === next.invalid
        ? prev
        : next,
    );
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Clear the highlight when the pointer leaves the row entirely (not when
    // moving between children inside the row). A fresh `dragover` on the next
    // row will set its own target.
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    // React clears currentTarget after the event callback returns, while a
    // functional state updater may run later. Capture the primitive id now so
    // the updater never reads from an expired synthetic event.
    const leavingTaskId = e.currentTarget.dataset.taskId;
    setDropTarget((prev) => (prev && prev.taskId === leavingTaskId ? null : prev));
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>, _target: TreeNode) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain') || draggedIdRef.current;
    cleanupDrag();
    if (!draggedId || dragCancelled.current) return;
    const target = dropTargetRef.current;
    if (!target || target.invalid) return;
    if (
      target.parentId === null &&
      target.order === 0 &&
      file.tasks.filter((t) => t.parentId === null).length === 0
    ) {
      // Edge case: empty root drop — nothing to reorder.
    }
    dispatch(moveTaskWithRollupCommand(draggedId, target.parentId, target.order));
  };

  const onDragEnd = () => {
    cleanupDrag();
  };

  const cleanupDrag = () => {
    if (dragEscapeHandler.current) {
      window.removeEventListener('keydown', dragEscapeHandler.current);
      dragEscapeHandler.current = null;
    }
    if (autoScrollRaf.current !== null) {
      cancelAnimationFrame(autoScrollRaf.current);
      autoScrollRaf.current = null;
    }
    setDraggedId(null);
    setDropTarget(null);
  };

  // Refs mirroring the latest drag state for use inside event handlers that
  // close over stale renders (window listeners, rAF callbacks).
  const draggedIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<TaskDropTarget | null>(null);
  draggedIdRef.current = draggedId;
  dropTargetRef.current = dropTarget;

  // Context-menu "Rename": TaskTable owns the inline-edit cell, so the menu
  // files a one-shot request here. Focus + reveal the row so Enter/Escape and
  // the blur-commit logic behave exactly like an F2 rename.
  const renameRequest = useViewStore((s) => s.renameRequest);
  useEffect(() => {
    if (!renameRequest) return;
    const idx = rows.findIndex((r) => r.task.id === renameRequest.taskId);
    if (idx === -1) return;
    selectSingle(renameRequest.taskId);
    focusAndRevealRow(scrollRef.current, idx, ROW_HEIGHT);
    startEditing(renameRequest.taskId, 'name');
    useViewStore.getState().clearRenameRequest();
  }, [renameRequest, rows, selectSingle, startEditing]);

  // Expand/collapse-all (search-bar buttons). Batch navigation, not undoable
  // data — written via direct setState like scrollTop, NOT setViewStateCommand,
  // so it never pollutes the undo stack (unlike the per-row toggle).
  const setCollapsedIds = (ids: string[]) => {
    useProjectStore.setState({
      file: { ...file, viewState: { ...file.viewState, collapsedTaskIds: ids } },
    });
  };
  const expandAll = () => setCollapsedIds([]);
  const collapseAll = () => {
    const parents = [
      ...new Set(file.tasks.map((t) => t.parentId).filter((id): id is string => id !== null)),
    ];
    setCollapsedIds(parents);
  };

  // Track the live pointer Y for auto-scroll, updated via a window listener
  // during a drag. Kept in a ref so we don't re-render per mousemove.
  const pointerY = useRef(0);

  // Auto-scroll: while a drag is in flight and the pointer is near the top or
  // bottom edge of the scroll container, scroll continuously so the user can
  // reach off-screen rows (plan §2.3). One rAF loop per drag.
  useEffect(() => {
    if (!draggedId) return;
    const onMove = (e: MouseEvent) => {
      pointerY.current = e.clientY;
    };
    window.addEventListener('mousemove', onMove);

    const tick = () => {
      const el = scrollRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const edge = ROW_HEIGHT * 2; // start scrolling within 2 rows of the edge
        const y = pointerY.current;
        if (y < rect.top + edge) {
          const speed = Math.min(20, (rect.top + edge - y) / 2);
          el.scrollTop -= speed;
        } else if (y > rect.bottom - edge) {
          const speed = Math.min(20, (y - (rect.bottom - edge)) / 2);
          el.scrollTop += speed;
        }
      }
      autoScrollRaf.current = requestAnimationFrame(tick);
    };
    autoScrollRaf.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('mousemove', onMove);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
    };
  }, [draggedId]);

  return (
    <>
      <div
        data-task-table
        className="relative flex shrink-0 flex-col border-r border-border bg-bg-elevated"
        style={{ width: tableWidth }}
      >
        {/* §4.1: drag the right edge to resize the table panel; double-click
            resets to the default. The handle straddles the border. */}
        <ResizeHandle
          ariaLabel={t('layout.resizePanel')}
          title={t('layout.resetPanelWidth')}
          dataResize="task-panel"
          className="-right-1"
          onResizeStart={(e) =>
            startPointerResize(e, { startWidth: panelWidth, onResize: setPanelWidth })
          }
          onReset={() => setPanelWidth(DEFAULT_PANEL_WIDTHS.task)}
        />
        {/* §4.4 search & filter bar — compact, above the table header. Search
            matches name/WBS; the three toggles are mutually-exclusive quick
            filters (unassigned / critical path / overdue). All ephemeral
            (useViewStore), never in the undo stack. */}
        <div
          data-task-search
          className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1"
          style={{ height: TASK_SEARCH_HEIGHT }}
        >
          <div className="relative flex min-w-0 flex-1 items-center">
            <Search
              size={13}
              className="pointer-events-none absolute left-1.5 text-fg-muted"
              aria-hidden
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              className="h-7 w-full rounded-md border border-border bg-bg pl-6 pr-5 text-xs text-fg outline-none placeholder:text-fg-muted focus-visible:border-primary"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label={t('search.clear')}
                className="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg hover:text-fg"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <FilterToggle
            active={taskFilter === 'unassigned'}
            onClick={() => setTaskFilter(taskFilter === 'unassigned' ? 'none' : 'unassigned')}
            label={t('filter.unassigned')}
            ariaLabel={t('filter.toggleLabel', { label: t('filter.unassigned') })}
          />
          <FilterToggle
            active={taskFilter === 'criticalPath'}
            onClick={() => setTaskFilter(taskFilter === 'criticalPath' ? 'none' : 'criticalPath')}
            label={t('filter.criticalPath')}
            ariaLabel={t('filter.toggleLabel', { label: t('filter.criticalPath') })}
          />
          <FilterToggle
            active={taskFilter === 'overdue'}
            onClick={() => setTaskFilter(taskFilter === 'overdue' ? 'none' : 'overdue')}
            label={t('filter.overdue')}
            ariaLabel={t('filter.toggleLabel', { label: t('filter.overdue') })}
          />
          {/* Batch tree navigation — direct view-state writes (never undoable). */}
          <div aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
          <button
            type="button"
            onClick={expandAll}
            aria-label={t('table.expandAll')}
            title={t('table.expandAll')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted outline-none transition hover:bg-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/35"
          >
            <ChevronsUpDown size={13} />
          </button>
          <button
            type="button"
            onClick={collapseAll}
            aria-label={t('table.collapseAll')}
            title={t('table.collapseAll')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted outline-none transition hover:bg-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/35"
          >
            <ChevronsDownUp size={13} />
          </button>
          {/* §3.1: task creation primary entry lives NEAR the task list (not the
              far toolbar). Uses the same shared helper as the zero-task empty
              state, so every entry point behaves identically (§5.1). */}
          <button
            type="button"
            onClick={() => createRootTask(t('table.placeholderName'))}
            aria-label={t('table.addTask')}
            title={t('table.addTask')}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-white outline-none shadow-sm transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/35"
          >
            <Plus size={13} strokeWidth={2.5} />
            {t('table.addTask')}
          </button>
        </div>
        <div
          className="grid shrink-0 items-center overflow-hidden border-b border-border bg-bg-elevated text-xs font-semibold text-fg-muted"
          style={{
            height: HEADER_HEIGHT - TASK_SEARCH_HEIGHT,
            gridTemplateColumns: gridTemplate,
          }}
        >
          <div className="flex h-full items-center border-r border-border px-2">
            {t('table.columnWbs')}
          </div>
          <div className="flex h-full items-center border-r border-border px-2">
            {t('table.columnName')}
          </div>
          <ResizableHeaderCell
            label={t('table.columnDuration')}
            width={durationWidth}
            defaultWidth={DEFAULT_COLUMN_WIDTHS.duration}
            dataResize="task-col-duration"
            className="flex h-full items-center py-0"
            onWidthChange={(w) => setColumnWidth('duration', w)}
          />
          <ResizableHeaderCell
            label={t('table.columnEffort')}
            width={effortWidth}
            defaultWidth={DEFAULT_COLUMN_WIDTHS.effort}
            dataResize="task-col-effort"
            className="flex h-full items-center py-0"
            onWidthChange={(w) => setColumnWidth('effort', w)}
          />
          <ResizableHeaderCell
            label={t('table.columnProgress')}
            width={progressWidth}
            defaultWidth={DEFAULT_COLUMN_WIDTHS.progress}
            dataResize="task-col-progress"
            className="flex h-full items-center py-0"
            onWidthChange={(w) => setColumnWidth('progress', w)}
          />
          {hasBaseline && (
            <ResizableHeaderCell
              label={t('baseline.columnDeviation')}
              width={baselineWidth}
              defaultWidth={DEFAULT_COLUMN_WIDTHS.baseline}
              dataResize="task-col-baseline"
              className="flex h-full items-center border-r-0 py-0"
              onWidthChange={(w) => setColumnWidth('baseline', w)}
            />
          )}
        </div>
        <div
          ref={scrollRef}
          data-task-scroll
          className="relative flex-1 overflow-y-auto"
          onScroll={onScroll}
        >
          {/* §5.2 empty states. Distinguish TRUE zero tasks (source of truth:
              file.tasks.length) from filter-induced emptiness (project has
              tasks but the projection is empty) — only the former offers the
              create-first-task CTA. */}
          {file.tasks.length === 0 ? (
            <EmptyState
              icon={<Plus size={22} />}
              title={t('empty.noTaskTitle')}
              description={t('empty.noTaskHint')}
              action={{
                label: t('empty.noTaskCta'),
                onClick: () => createRootTask(t('table.placeholderName')),
              }}
            />
          ) : rows.length === 0 ? (
            <EmptyState title={t('empty.filteredTitle')} description={t('empty.filteredHint')} />
          ) : (
            <div
              role="treegrid"
              aria-label={t('table.taskColumnsHeader')}
              className="relative"
              style={{ height: Math.max(rows.length * ROW_HEIGHT, 0) }}
            >
              {rows.map((node, i) => {
                const y = i * ROW_HEIGHT;
                // §4.6: highlight every selected row; the anchor gets a stronger
                // ring so the user can tell which task the drawer would edit.
                const selected = selectedTaskIds.has(node.task.id);
                const isAnchor = anchorTaskId === node.task.id;
                const activeField =
                  editingCell.current?.taskId === node.task.id ? editingCell.current.field : null;
                const isDropHere = dropTarget?.taskId === node.task.id && !dropTarget.invalid;
                const isDragged = draggedId === node.task.id;
                const invalidHere = dropTarget?.taskId === node.task.id && dropTarget.invalid;
                const isParent = node.children.length > 0;
                const collapsed = file.viewState.collapsedTaskIds.includes(node.task.id);
                // Insertion line aligns with the NAME cell's tree indent
                // (grip slot + guides + chevron slot), not the flat WBS number.
                const dropIndent = wbsWidth + node.depth * 16 + 20;
                return (
                  <div
                    key={node.task.id}
                    role="row"
                    tabIndex={0}
                    aria-selected={selected}
                    aria-level={node.depth + 1}
                    aria-expanded={isParent ? !collapsed : undefined}
                    onDrop={(e) => onDrop(e, node)}
                    onDragOver={(e) => onDragOver(e, node)}
                    onDragLeave={onDragLeave}
                    data-task-id={node.task.id}
                    data-keyboard-row-index={i}
                    onClick={(e) => {
                      // Modifier-clicks (Cmd/Ctrl/Shift) are pure selection
                      // changes — never open the drawer or start inline edit, so
                      // bail before the double-click handler can also fire.
                      if (e.ctrlKey || e.metaKey || e.shiftKey) {
                        select(node.task.id, e);
                        return;
                      }
                      select(node.task.id, e);
                    }}
                    onDoubleClick={(e) => {
                      // Modifier-double-click is ambiguous with multi-select; only
                      // plain double-click opens (matches historical UX).
                      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                      // ONE rule, everywhere on the row: double-click opens the
                      // drawer. Inline edit is reached via F2 (+Tab traversal) or
                      // the context menu's 重命名 — never a hidden pixel boundary.
                      select(node.task.id);
                      openDrawer();
                    }}
                    onKeyDown={(e) => onKeyDown(e, node)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      // Right-click always focuses a single task (the menu is
                      // single-task today) — plain-select the clicked row first.
                      selectSingle(node.task.id);
                      openContextMenu(node.task.id, e.clientX, e.clientY);
                    }}
                    onBlur={(e) => {
                      // Only stop editing when focus actually leaves this row.
                      // Without the relatedTarget check, focusing the inline-edit
                      // input (a child) would fire focusout on the row and
                      // immediately cancel the edit we just opened.
                      const next = e.relatedTarget as Node | null;
                      if (next && e.currentTarget.contains(next)) return;
                      if (activeField) {
                        stopEditing();
                      }
                    }}
                    style={{
                      height: ROW_HEIGHT,
                      transform: `translateY(${y}px)`,
                      gridTemplateColumns: gridTemplate,
                    }}
                    className={cn(
                      'group/row absolute left-0 right-0 grid cursor-pointer items-center border-b border-border text-xs outline-none',
                      'hover:bg-bg',
                      // §4.6: every selected row gets a bg + inset ring; the
                      // anchor (primary selection) gets a stronger 2px ring so it
                      // stands out within a multi-selection.
                      selected && !isAnchor && 'bg-bg ring-1 ring-inset ring-primary/60',
                      isAnchor && 'bg-bg ring-2 ring-inset ring-primary',
                      node.children.length > 0 && !selected && 'bg-bg-elevated',
                      isDragged && 'opacity-40',
                      invalidHere && 'cursor-not-allowed',
                      isDropHere &&
                        dropTarget!.position === 'inside' &&
                        'bg-primary/10 ring-1 ring-inset ring-primary',
                    )}
                  >
                    {/* Insertion line for before/after drops (plan §2.3). */}
                    {isDropHere &&
                      (dropTarget!.position === 'before' || dropTarget!.position === 'after') && (
                        <div
                          aria-hidden
                          className="pointer-events-none absolute left-0 right-0 bg-primary"
                          style={{
                            height: 2,
                            top: dropTarget!.position === 'before' ? -1 : ROW_HEIGHT - 1,
                            // Indent the line to the target's depth so it reads as
                            // a sibling insertion, not a root move.
                            left: dropIndent,
                            zIndex: 5,
                          }}
                        />
                      )}
                    <div
                      data-field="wbs"
                      className="flex h-full items-center overflow-hidden border-r border-border text-fg-muted"
                    >
                      {/* Drag grip — the ONLY drag source on the row (the row
                       * itself is not draggable, so clicks never turn into
                       * accidental drags). The 18px slot is always reserved and
                       * the icon only animates opacity: hovering can never shift
                       * the number or the name cell's chevron. Clicks are
                       * isolated — grabbing here neither selects nor opens. */}
                      <div
                        data-testid="row-drag-handle"
                        draggable
                        onDragStart={(e) => onDragStart(e, node)}
                        onDragEnd={onDragEnd}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={t('table.dragHint')}
                        className="flex h-full w-[18px] shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
                      >
                        <GripVertical
                          size={12}
                          aria-hidden
                          className="text-fg-muted/60 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100 hover:text-fg"
                        />
                      </div>
                      <span
                        data-testid="wbs-number"
                        className="pl-1.5 text-[11px] leading-none tabular-nums"
                      >
                        {node.wbsNumber}
                      </span>
                    </div>
                    <div
                      data-field="name"
                      className="flex h-full min-w-0 items-center border-r border-border"
                    >
                      {/* Tree structure lives HERE, not in the WBS number:
                       * per-depth guide lines + a chevron slot reserved on
                       * every row, so parents (chevron + semibold) vs leaves
                       * are distinguishable at a glance and sibling names
                       * stay strictly aligned. */}
                      {Array.from({ length: node.depth }).map((_, d) => (
                        <span
                          key={d}
                          aria-hidden
                          className="h-full w-4 shrink-0 border-r border-border/60"
                        />
                      ))}
                      {isParent ? (
                        <button
                          type="button"
                          data-testid="expand-toggle"
                          aria-expanded={!collapsed}
                          aria-label={collapsed ? t('table.expandTask') : t('table.collapseTask')}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCollapse(node.task.id);
                          }}
                          onDoubleClick={(e) => e.stopPropagation()}
                          className="flex h-5 w-4 shrink-0 items-center justify-center rounded-sm text-fg-muted outline-none transition-colors hover:bg-bg hover:text-fg focus-visible:ring-1 focus-visible:ring-primary/40"
                        >
                          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </button>
                      ) : (
                        <span aria-hidden className="w-4 shrink-0" />
                      )}
                      <div className="flex min-w-0 flex-1 items-center pl-1 pr-2">
                        {node.task.isMilestone && (
                          <span className="mr-1 shrink-0 text-warning">◆</span>
                        )}
                        {activeField === 'name' ? (
                          <input
                            autoFocus
                            defaultValue={node.task.name}
                            // Commit-on-blur matches the original F2 behaviour. The
                            // guard avoids a double-dispatch when Enter/Tab already
                            // committed: those handlers call stopEditing() first,
                            // which nulls editingCell before blur fires.
                            onBlur={(e) => {
                              if (editingCell.current?.taskId !== node.task.id) {
                                commitName(node.task.id, e.target.value);
                                stopEditing();
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitName(node.task.id, (e.target as HTMLInputElement).value);
                                stopEditing();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                stopEditing();
                              } else if (e.key === 'Tab') {
                                e.preventDefault();
                                commitName(node.task.id, (e.target as HTMLInputElement).value);
                                tabCell(node.task.id, 'name', e.shiftKey, node);
                              }
                            }}
                            className="h-5 min-w-0 flex-1 rounded-sm bg-transparent outline-none"
                          />
                        ) : (
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate font-medium',
                              isParent && 'font-semibold',
                            )}
                          >
                            {node.task.name || t('table.placeholderName')}
                          </span>
                        )}
                        {/* Collapsed parents quantify their hidden children
                         * (Notion-style count chip) so nothing is silently
                         * invisible; expanded rows show the children anyway. */}
                        {isParent && collapsed && activeField !== 'name' && (
                          <span
                            data-testid="child-count"
                            className="ml-1.5 shrink-0 rounded bg-bg px-1 text-[10px] leading-4 tabular-nums text-fg-muted"
                          >
                            {t('table.childCount', { count: node.children.length })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      data-field="duration"
                      title={
                        node.children.length > 0
                          ? t('table.cellReadOnlySummary')
                          : node.task.isMilestone
                            ? t('table.cellReadOnlyMilestone')
                            : undefined
                      }
                      className="border-r border-border px-2 text-right tabular-nums text-fg-muted"
                    >
                      {activeField === 'duration' && isFieldEditable(node, 'duration') ? (
                        <input
                          autoFocus
                          type="number"
                          min={0}
                          defaultValue={node.task.duration}
                          aria-label={t('table.editDurationAria')}
                          onBlur={(e) => {
                            if (editingCell.current?.taskId !== node.task.id) {
                              commitDuration(node.task.id, Number(e.target.value));
                              stopEditing();
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitDuration(
                                node.task.id,
                                Number((e.target as HTMLInputElement).value),
                              );
                              stopEditing();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              stopEditing();
                            } else if (e.key === 'Tab') {
                              e.preventDefault();
                              commitDuration(
                                node.task.id,
                                Number((e.target as HTMLInputElement).value),
                              );
                              tabCell(node.task.id, 'duration', e.shiftKey, node);
                            }
                          }}
                          className="w-full bg-transparent text-right outline-none"
                        />
                      ) : node.task.isMilestone ? (
                        '—'
                      ) : (
                        `${node.task.duration}d`
                      )}
                    </div>
                    <div
                      data-field="effort"
                      className="border-r border-border px-2 text-right tabular-nums text-fg-muted"
                    >
                      {(() => {
                        const pd =
                          node.children.length > 0
                            ? effortMap.get(node.task.id)?.personDays
                            : computeTaskPersonDays(node.task, file.resources, cal);
                        return pd && pd > 0 ? `${pd}` : '—';
                      })()}
                    </div>
                    <div
                      data-field="progress"
                      title={node.children.length > 0 ? t('table.cellReadOnlySummary') : undefined}
                      className="border-r border-border px-2 text-right tabular-nums text-fg-muted"
                    >
                      {activeField === 'progress' && isFieldEditable(node, 'progress') ? (
                        <input
                          autoFocus
                          type="number"
                          min={0}
                          max={100}
                          defaultValue={node.task.progress}
                          aria-label={t('table.editProgressAria')}
                          onBlur={(e) => {
                            if (editingCell.current?.taskId !== node.task.id) {
                              commitProgress(node.task.id, Number(e.target.value));
                              stopEditing();
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitProgress(
                                node.task.id,
                                Number((e.target as HTMLInputElement).value),
                              );
                              stopEditing();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              stopEditing();
                            } else if (e.key === 'Tab') {
                              e.preventDefault();
                              commitProgress(
                                node.task.id,
                                Number((e.target as HTMLInputElement).value),
                              );
                              tabCell(node.task.id, 'progress', e.shiftKey, node);
                            }
                          }}
                          className="w-full bg-transparent text-right outline-none"
                        />
                      ) : (
                        `${node.task.progress}%`
                      )}
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
          )}
        </div>
      </div>
      {confirmDeleteTaskId && (
        <DeleteTaskConfirm
          taskId={confirmDeleteTaskId}
          onClose={() => setConfirmDeleteTaskId(null)}
        />
      )}
      {batchDeleteIds && (
        <BatchDeleteConfirm ids={batchDeleteIds} onClose={() => setBatchDeleteIds(null)} />
      )}
    </>
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
  const { t } = useTranslation();
  const eff = baselineCtx.effective.get(taskId);
  if (!eff) return <div className="px-2 text-right tabular-nums text-fg-muted">—</div>;
  const variance = compareTaskToBaseline(eff, baselineCtx.byId.get(taskId), cal);
  const cell = deviationColumnCell(variance, t);
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
          <td className="tabular-nums">{formatSigned(variance.startDelta, t)}</td>
        </tr>
        <tr>
          <td className="pr-3 text-fg-muted">{t('baseline.varianceFinish')}</td>
          <td className="tabular-nums font-medium">{formatSigned(variance.finishDelta, t)}</td>
        </tr>
        <tr>
          <td className="pr-3 text-fg-muted">{t('baseline.varianceDuration')}</td>
          <td className="tabular-nums">{formatSigned(variance.durationDelta, t)}</td>
        </tr>
      </tbody>
    </table>
  );
}

const MINUS_CH = '\u2212';
function formatSigned(n: number, t: TFunction): string {
  if (n > 0) return t('baseline.deltaDays', { n: `+${n}` });
  if (n < 0) return t('baseline.deltaDays', { n: `${MINUS_CH}${Math.abs(n)}` });
  return '0';
}
