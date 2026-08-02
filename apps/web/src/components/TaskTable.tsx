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
  updateTaskFromDraftCommand,
  swapSiblingOrderCommand,
  pasteTaskCommand,
  type Command,
} from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { buildTree, flattenVisible, type TreeNode } from '@/engine/scene';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';
import { cn } from '@/lib/cn';
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

const TABLE_WIDTH = 480;
const TABLE_WIDTH_WITH_BASELINE = 552;
/**
 * 共享列模板：表头与每行数据必须用同一个，否则列宽按行内容自适应，
 * 会导致 WBS/工期/进度列与表头错位、长任务名挤压（bug: 左侧明细挤在一起）。
 * “人天”列（56px）恒驻于工期与进度之间；基线偏差列（baseline-comparison spec
 * §5.6）仅在比较模式开启时追加 70px。
 */
const GRID_TEMPLATE = '44px minmax(0, 1fr) 72px 56px 56px';
const GRID_TEMPLATE_WITH_BASELINE = '44px minmax(0, 1fr) 72px 56px 56px 70px';

/**
 * The three task-table cells that support inline editing (plan §4.3). Order
 * matters: it defines the Tab-traversal sequence within a row.
 */
type EditableField = 'name' | 'duration' | 'progress';
const EDITABLE_FIELDS: readonly EditableField[] = ['name', 'duration', 'progress'] as const;

export function TaskTable() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const openContextMenu = useViewStore((s) => s.openContextMenu);
  const activeBaselineId = useViewStore((s) => s.activeBaselineId);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Which cell is in inline-edit mode (plan §4.3). `name` is the existing F2
  // rename; `duration`/`progress` are new. A ref + forceRerender keeps the
  // editing input uncontrolled, matching the original F2 pattern.
  const editingCell = useRef<{ taskId: string; field: EditableField } | null>(null);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);

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

  const gridTemplate = hasBaseline ? GRID_TEMPLATE_WITH_BASELINE : GRID_TEMPLATE;
  const tableWidth = hasBaseline ? TABLE_WIDTH_WITH_BASELINE : TABLE_WIDTH;
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

    // An inline-edit input (F2 rename, duration/progress editor) has the focus:
    // let it handle its own keys. Without this, Delete/Enter/F2 would bubble
    // out of the input and mis-trigger task ops (plan §4.2 — "输入任务名称时
    // Delete 不误删任务").
    if (isEditableTarget(e.target)) return;

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
    dispatch(setViewStateCommand({ selectedTaskId: id }));
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
    setDropTarget((prev) => (prev && prev.taskId === e.currentTarget.dataset.taskId ? null : prev));
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
          <div className="border-r border-border px-2 py-1">{t('table.columnEffort')}</div>
          <div className="border-r border-border px-2 py-1">{t('table.columnProgress')}</div>
          {hasBaseline && <div className="px-2 py-1">{t('baseline.columnDeviation')}</div>}
        </div>
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto" onScroll={onScroll}>
          <div className="relative" style={{ height: Math.max(rows.length * ROW_HEIGHT, 0) }}>
            {rows.map((node, i) => {
              const y = i * ROW_HEIGHT;
              const selected = file.viewState.selectedTaskId === node.task.id;
              const activeField =
                editingCell.current?.taskId === node.task.id ? editingCell.current.field : null;
              const isDropHere = dropTarget?.taskId === node.task.id && !dropTarget.invalid;
              const isDragged = draggedId === node.task.id;
              const invalidHere = dropTarget?.taskId === node.task.id && dropTarget.invalid;
              const dropIndent = 8 + node.depth * 16;
              return (
                <div
                  key={node.task.id}
                  role="row"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => onDragStart(e, node)}
                  onDrop={(e) => onDrop(e, node)}
                  onDragOver={(e) => onDragOver(e, node)}
                  onDragLeave={onDragLeave}
                  onDragEnd={onDragEnd}
                  data-task-id={node.task.id}
                  onClick={() => select(node.task.id)}
                  onDoubleClick={(e) => {
                    select(node.task.id);
                    // Double-clicking an editable data cell enters inline edit
                    // (plan §4.3); double-clicking anywhere else (WBS, effort,
                    // padding) opens the drawer.
                    const field = (e.target as HTMLElement)
                      .closest('[data-field]')
                      ?.getAttribute('data-field') as EditableField | null;
                    if (field && EDITABLE_FIELDS.includes(field) && isFieldEditable(node, field)) {
                      startEditing(node.task.id, field);
                      return;
                    }
                    openDrawer();
                  }}
                  onKeyDown={(e) => onKeyDown(e, node)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    select(node.task.id);
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
                    selected && 'bg-bg ring-1 ring-inset ring-primary',
                    node.children.length > 0 && 'bg-bg-elevated',
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
                    className="group/cell flex items-center overflow-hidden border-r border-border px-2 text-fg-muted"
                    style={{ paddingLeft: 8 + node.depth * 16 }}
                  >
                    {/* Drag handle — visible on row hover/focus, gives the row a
                     * clear "grab here to reorder" affordance without colliding
                     * with the row's click-to-select / double-click-to-edit
                     * semantics (plan §2.3 step 6). */}
                    <span
                      aria-hidden
                      title={t('table.dragHint')}
                      className="mr-1 hidden shrink-0 cursor-grab text-[10px] leading-none text-fg-muted/50 hover:text-fg group-hover/row:inline-block active:cursor-grabbing"
                    >
                      ⠿
                    </span>
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
                    data-field="name"
                    className={cn(
                      'min-w-0 truncate border-r border-border px-2 font-medium',
                      node.children.length > 0 && 'font-semibold',
                    )}
                  >
                    {node.task.isMilestone && <span className="mr-1 text-warning">◆</span>}
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
                        className="w-full bg-transparent outline-none"
                      />
                    ) : (
                      node.task.name || t('table.placeholderName')
                    )}
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
        </div>
      </div>
      {confirmDeleteTaskId && (
        <DeleteTaskConfirm
          taskId={confirmDeleteTaskId}
          onClose={() => setConfirmDeleteTaskId(null)}
        />
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
