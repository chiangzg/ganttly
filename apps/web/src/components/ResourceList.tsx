/**
 * Resource list — the left pane of the resource view (P1 feature one, G7).
 *
 * Mirrors TaskTable's layout and vertical-scroll-sync contract so that rows
 * align pixel-for-pixel with ResourceLoadCanvas on the right:
 * - Shared `ROW_HEIGHT` (32) / `HEADER_HEIGHT` (56) from `@/engine/layout`.
 * - Scroll writes to `useViewStore.resourceScrollTop` (G19: independent of the
 *   task view's `file.viewState.scrollTop`, because row counts differ).
 *
 * The right pane (ResourceLoadCanvas) reads `resourceScrollTop` and renders
 * with the same row pitch, exactly as GanttCanvas follows TaskTable.
 *
 * Drill-down: clicking a resource's expand arrow inserts a local task header
 * and task lanes beneath it (WBS | name | duration | progress, indented). The
 * flattened row list (resources + local task headers + expanded task lanes)
 * drives BOTH this list and the canvas, so both panes share identical total
 * height and row indices.
 *
 * Interaction model (mirrors the modernized TaskTable, adapted to a
 * person-centric flat list):
 * - Click row = select; double-click row = expand/collapse the drill-down
 *   (a person's "detail" is the list of their tasks).
 * - Name/role/capacity render as static text; F2 (or the context menu's
 *   重命名) starts inline editing, Tab hops name → role → capacity. Each
 *   committed edit dispatches ONE updateResourceCommand (no per-keystroke
 *   undo pollution, unlike the old always-on inputs).
 * - Row order is changed by dragging the hover-revealed grip (the only drag
 *   source) — drop dispatches a single moveResourceCommand.
 * - Hover affordances (grip, delete) only animate opacity inside reserved
 *   slots: hovering never shifts content.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Resource, Task } from '@ganttly/schema';
import {
  useProjectStore,
  addResourceCommand,
  updateResourceCommand,
  moveResourceCommand,
} from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';
import { buildTree } from '@/engine/scene/tree';
import { tasksByResource } from '@/lib/resourceTasks';
import { computeAssignmentPersonDays } from '@/lib/cost';
import { resolveCalendar } from '@/lib/calendar';
import { cn } from '@/lib/cn';
import { nanoid } from 'nanoid';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  GripVertical,
  Plus,
  X,
} from 'lucide-react';
import { DeleteResourceConfirm } from './DeleteResourceConfirm';
import { EmptyState } from './ui/EmptyState';
import { usePanelWidth, useColumnWidths } from './useLayoutPrefs';
import { ResizeHandle, ResizableHeaderCell, startPointerResize } from './ui/ResizeHandle';
import { DEFAULT_PANEL_WIDTHS, DEFAULT_COLUMN_WIDTHS } from '@/lib/layoutPrefs';
import { isEditableTarget } from '@/lib/shortcutTarget';
import { adjacentSelectableRow, focusAndRevealRow } from '@/lib/rowKeyboardNavigation';

// §4.1: the resource panel width (default 420, 300-640) and the role/capacity
// column widths are per-project user preferences; the name column stays
// `minmax(0, 1fr)` and absorbs every width delta.
/**
 * Task-lane grid: expand arrow | WBS | name | duration | person-days | progress.
 * The person-days column sits between duration and progress (mirrors
 * TaskTable's effort column placement). The resource-row grid (gridTemplate)
 * is unaffected — only the local task header and drilled-down task lanes get
 * the column, consistent with TaskTable. Fixed (read-only drill-down; column
 * resize is out of scope for §4.1).
 */
const TASK_GRID_TEMPLATE = '20px 44px minmax(0, 1fr) 52px 52px 44px';

/** Inline-editable resource fields, in Tab-traversal order. */
type EditableField = 'name' | 'role' | 'capacity';
const EDITABLE_FIELDS: readonly EditableField[] = ['name', 'role', 'capacity'];

/**
 * Person avatar palette (the resource view is people-centric — the avatar is
 * the identity marker, like the task tree's chevron + semibold parents).
 * Stable by name hash; soft 15% fills read on both light and dark themes.
 */
const AVATAR_COLORS = [
  'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
] as const;

function avatarColorOf(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

/** "孟祥俊" → 孟, "Zhang San" → ZS, "Alice" → A. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return words[0]![0]!.toUpperCase();
}

export function ResourceList() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const resourceScrollTop = useViewStore((s) => s.resourceScrollTop);
  const setResourceScrollTop = useViewStore((s) => s.setResourceScrollTop);
  const selectedResourceId = useViewStore((s) => s.selectedResourceId);
  const setSelectedResourceId = useViewStore((s) => s.setSelectedResourceId);
  const expandedResourceIds = useViewStore((s) => s.expandedResourceIds);
  const toggleResourceExpanded = useViewStore((s) => s.toggleResourceExpanded);
  const selectedTaskIdInResource = useViewStore((s) => s.selectedTaskIdInResource);
  const setSelectedTaskIdInResource = useViewStore((s) => s.setSelectedTaskIdInResource);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const openResourceContextMenu = useViewStore((s) => s.openResourceContextMenu);
  const resourceRenameRequest = useViewStore((s) => s.resourceRenameRequest);
  // §4.1: panel + column widths are per-project user preferences (localStorage,
  // never in the project file or the undo stack).
  const [panelWidth, setPanelWidth] = usePanelWidth('resource');
  const { widths: colWidths, setColumnWidth } = useColumnWidths('resource');
  const roleWidth = colWidths.role ?? DEFAULT_COLUMN_WIDTHS.role;
  const capacityWidth = colWidths.capacity ?? DEFAULT_COLUMN_WIDTHS.capacity;
  const tableWidth = panelWidth;
  const gridTemplate = `minmax(0, 1fr) ${roleWidth}px ${capacityWidth}px 28px`;
  const taskGridTemplate = TASK_GRID_TEMPLATE;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [confirmDeleteResourceId, setConfirmDeleteResourceId] = useState<string | null>(null);
  const cal = useMemo(() => resolveCalendar(file.calendar), [file.calendar]);

  // Inline editing (TaskTable's editingCell pattern: a ref so blur handlers
  // read the live cell, plus a counter to re-render). One commit = one
  // updateResourceCommand — the old always-on inputs dispatched per keystroke
  // and flooded the undo stack.
  const editingCell = useRef<{ resourceId: string; field: EditableField } | null>(null);
  const [, forceRerender] = useState(0);
  const startEditing = (resourceId: string, field: EditableField) => {
    editingCell.current = { resourceId, field };
    forceRerender((n) => n + 1);
  };
  const stopEditing = () => {
    editingCell.current = null;
    forceRerender((n) => n + 1);
  };
  const activeFieldOf = (resourceId: string): EditableField | null =>
    editingCell.current?.resourceId === resourceId ? editingCell.current.field : null;

  /** Commit one field; skipped entirely when the value is unchanged so the
   * undo stack never gains a no-op entry. */
  const commitField = (resource: Resource, field: EditableField, raw: string) => {
    if (field === 'name') {
      if (raw !== resource.name) dispatch(updateResourceCommand(resource.id, { name: raw }));
      return;
    }
    if (field === 'role') {
      if (raw !== (resource.role ?? ''))
        dispatch(updateResourceCommand(resource.id, { role: raw }));
      return;
    }
    const pct = Math.max(0, Math.min(100, Number(raw) || 0));
    if (pct !== Math.round((resource.capacity ?? 1) * 100)) {
      dispatch(updateResourceCommand(resource.id, { capacity: pct / 100 }));
    }
  };

  /** Tab traversal: name → role → capacity → row focus. Shift+Tab reverses. */
  const tabField = (resourceId: string, field: EditableField, shiftKey: boolean) => {
    const index = EDITABLE_FIELDS.indexOf(field);
    const next = index + (shiftKey ? -1 : 1);
    if (next >= 0 && next < EDITABLE_FIELDS.length) {
      editingCell.current = { resourceId, field: EDITABLE_FIELDS[next]! };
      forceRerender((n) => n + 1);
      return;
    }
    stopEditing();
    (
      scrollRef.current?.querySelector(`[data-resource-id="${resourceId}"]`) as HTMLElement | null
    )?.focus();
  };

  // Leaf-task reverse lookup (consistent with computeResourceLoad's leaf rule).
  const tasksByRes = useMemo(() => {
    const tree = buildTree(file.tasks);
    const childSet = new Set<string>();
    const walk = (nodes: ReadonlyArray<(typeof tree)[number]>): void => {
      for (const n of nodes) {
        if (n.children.length > 0) childSet.add(n.task.id);
        walk(n.children);
      }
    };
    walk(tree);
    const wbsByTaskId = new Map<string, string>();
    const indexWbs = (nodes: ReadonlyArray<(typeof tree)[number]>): void => {
      for (const n of nodes) {
        wbsByTaskId.set(n.task.id, n.wbsNumber);
        indexWbs(n.children);
      }
    };
    indexWbs(tree);
    const map = tasksByResource(file.tasks, (id) => childSet.has(id));
    return { map, wbsByTaskId };
  }, [file.tasks]);

  // Flattened rows (resources + local task headers + expanded task lanes),
  // shared with the canvas so both panes use the same row count and y positions.
  type FlatRow =
    | { kind: 'resource'; resourceId: string; yIndex: number }
    | { kind: 'task-header'; resourceId: string; yIndex: number }
    | { kind: 'task'; resourceId: string; task: Task; yIndex: number };
  const flatRows: FlatRow[] = useMemo(() => {
    const out: FlatRow[] = [];
    let yIndex = 0;
    for (const r of file.resources) {
      out.push({ kind: 'resource', resourceId: r.id, yIndex: yIndex++ });
      if (expandedResourceIds.has(r.id)) {
        const list = tasksByRes.map.get(r.id) ?? [];
        if (list.length > 0) {
          out.push({ kind: 'task-header', resourceId: r.id, yIndex: yIndex++ });
        }
        for (const task of list) {
          out.push({ kind: 'task', resourceId: r.id, task, yIndex: yIndex++ });
        }
      }
    }
    return out;
  }, [file.resources, expandedResourceIds, tasksByRes]);
  const selectableRowIndexes = useMemo(
    () => flatRows.flatMap((row, index) => (row.kind === 'task-header' ? [] : [index])),
    [flatRows],
  );

  // Reflect store-driven scroll changes onto this panel (mirrors TaskTable).
  const localScrolling = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || localScrolling.current) return;
    if (Math.abs(el.scrollTop - resourceScrollTop) > 1) {
      el.scrollTop = resourceScrollTop;
    }
  }, [resourceScrollTop]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    localScrolling.current = true;
    if (top !== resourceScrollTop) setResourceScrollTop(top);
    requestAnimationFrame(() => {
      localScrolling.current = false;
    });
  };

  const addResource = () => {
    const id = nanoid(10);
    dispatch(
      addResourceCommand({
        id,
        name: t('resource.placeholderName'),
        capacity: 1.0,
      }),
    );
    setSelectedResourceId(id);
    // Like TaskTable's Enter-new-task: the new row starts in name editing.
    startEditing(id, 'name');
  };

  const removeResource = (resourceId: string) => {
    setConfirmDeleteResourceId(resourceId);
  };

  // Expand/collapse-all (header buttons). Ephemeral drill-down state, written
  // via direct setState — never in the undo stack. Resources without assigned
  // leaf tasks are skipped (expanding them renders nothing).
  const expandAllResources = () => {
    const ids = file.resources
      .filter((r) => (tasksByRes.map.get(r.id)?.length ?? 0) > 0)
      .map((r) => r.id);
    useViewStore.setState({ expandedResourceIds: new Set(ids) });
  };
  const collapseAllResources = () => {
    useViewStore.setState({ expandedResourceIds: new Set<string>() });
  };

  // Context-menu "重命名": ResourceList owns the editing cell, so the menu
  // files a one-shot request here. Focus + reveal the row first so Enter /
  // Escape and the blur-commit logic behave exactly like an F2 rename.
  useEffect(() => {
    if (!resourceRenameRequest) return;
    const idx = flatRows.findIndex(
      (row) => row.kind === 'resource' && row.resourceId === resourceRenameRequest.resourceId,
    );
    if (idx === -1) return;
    setSelectedResourceId(resourceRenameRequest.resourceId);
    focusAndRevealRow(scrollRef.current, idx, ROW_HEIGHT);
    startEditing(resourceRenameRequest.resourceId, 'name');
    useViewStore.getState().clearResourceRenameRequest();
  }, [resourceRenameRequest]);

  const selectFlatRow = (row: FlatRow) => {
    if (row.kind === 'resource') {
      setSelectedResourceId(row.resourceId);
      return;
    }
    if (row.kind === 'task') {
      setSelectedResourceId(row.resourceId);
      setSelectedTaskIdInResource(row.task.id);
    }
  };

  const selectAndFocusFlatRow = (rowIndex: number) => {
    const target = flatRows[rowIndex];
    if (!target || target.kind === 'task-header') return;
    selectFlatRow(target);
    focusAndRevealRow(scrollRef.current, rowIndex, ROW_HEIGHT);
  };

  const onRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, row: FlatRow) => {
    if (isEditableTarget(e.target)) return;
    const hasModifier = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
    if (!hasModifier && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const nextIndex = adjacentSelectableRow(
        row.yIndex,
        selectableRowIndexes,
        e.key === 'ArrowUp' ? -1 : 1,
      );
      if (nextIndex === null) return;
      selectAndFocusFlatRow(nextIndex);
      return;
    }

    if (hasModifier) return;

    // Resource-row operations (match the task table: F2 rename, Delete with
    // an in-app confirmation).
    if (row.kind === 'resource') {
      if (e.key === 'F2') {
        e.preventDefault();
        startEditing(row.resourceId, 'name');
        return;
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        setSelectedResourceId(row.resourceId);
        setConfirmDeleteResourceId(row.resourceId);
        return;
      }
    }

    if (e.key === 'ArrowRight' && row.kind === 'resource') {
      const expanded = expandedResourceIds.has(row.resourceId);
      const hasTasks = (tasksByRes.map.get(row.resourceId)?.length ?? 0) > 0;
      if (!hasTasks) return;
      e.preventDefault();
      if (!expanded) {
        setSelectedResourceId(row.resourceId);
        toggleResourceExpanded(row.resourceId);
        return;
      }

      const childIndex = flatRows.findIndex(
        (candidate, index) =>
          index > row.yIndex &&
          candidate.kind === 'task' &&
          candidate.resourceId === row.resourceId,
      );
      if (childIndex !== -1) selectAndFocusFlatRow(childIndex);
      return;
    }

    if (e.key === 'ArrowLeft') {
      if (row.kind === 'resource') {
        if (!expandedResourceIds.has(row.resourceId)) return;
        e.preventDefault();
        setSelectedResourceId(row.resourceId);
        toggleResourceExpanded(row.resourceId);
        return;
      }

      const parentIndex = flatRows.findIndex(
        (candidate) => candidate.kind === 'resource' && candidate.resourceId === row.resourceId,
      );
      if (parentIndex === -1) return;
      e.preventDefault();
      selectAndFocusFlatRow(parentIndex);
    }
  };

  // ---- Drag & drop reorder (flat list; mirrors TaskTable's grip-only DnD) ----
  // The drag preview is pure local React state; the only thing that hits the
  // undo stack is the final `onDrop` dispatch (a single moveResourceCommand).
  const [draggedResourceId, setDraggedResourceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    rowId: string;
    position: 'before' | 'after';
  } | null>(null);
  const dragCancelled = useRef(false);
  const dragEscapeHandler = useRef<((e: globalThis.KeyboardEvent) => void) | null>(null);
  const autoScrollRaf = useRef<number | null>(null);
  const pointerY = useRef(0);
  // Refs mirroring the latest drag state for handlers that close over stale
  // renders (window listeners, native drop events).
  const draggedIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ rowId: string; position: 'before' | 'after' } | null>(null);
  draggedIdRef.current = draggedResourceId;
  dropTargetRef.current = dropTarget;

  const cleanupDrag = () => {
    if (dragEscapeHandler.current) {
      window.removeEventListener('keydown', dragEscapeHandler.current);
      dragEscapeHandler.current = null;
    }
    setDraggedResourceId(null);
    setDropTarget(null);
  };

  const onGripDragStart = (e: React.DragEvent<HTMLDivElement>, resourceId: string) => {
    e.dataTransfer.setData('text/plain', resourceId);
    e.dataTransfer.effectAllowed = 'move';
    // A transparent drag image lets us show our own insertion-line feedback
    // instead of the browser's faded row ghost. Escape cancels mid-drag.
    dragCancelled.current = false;
    setDraggedResourceId(resourceId);
    const onEsc = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') {
        dragCancelled.current = true;
        cleanupDrag();
      }
    };
    dragEscapeHandler.current = onEsc;
    window.addEventListener('keydown', onEsc);
  };

  const onRowDragOver = (e: React.DragEvent<HTMLDivElement>, resourceId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = dragCancelled.current ? 'none' : 'move';
    if (!draggedResourceId || dragCancelled.current) return;
    // The dragged row's own boundaries are meaningless drop targets.
    if (resourceId === draggedResourceId) {
      setDropTarget((prev) => (prev ? null : prev));
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY - rect.top < ROW_HEIGHT / 2;
    const position = before ? 'before' : 'after';
    setDropTarget((prev) =>
      prev && prev.rowId === resourceId && prev.position === position
        ? prev
        : { rowId: resourceId, position },
    );
  };

  const onRowDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Clear the line when the pointer leaves the row entirely (not when
    // moving between children inside the row). Capture the primitive id now:
    // React clears currentTarget after the callback returns, while the state
    // updater may run later.
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    const leavingId = e.currentTarget.dataset.resourceId;
    setDropTarget((prev) => (prev && prev.rowId === leavingId ? null : prev));
  };

  const onRowDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain') || draggedIdRef.current;
    cleanupDrag();
    if (!draggedId || dragCancelled.current) return;
    const target = dropTargetRef.current;
    if (!target) return;
    const from = file.resources.findIndex((r) => r.id === draggedId);
    const targetIdx = file.resources.findIndex((r) => r.id === target.rowId);
    if (from === -1 || targetIdx === -1) return;
    // Convert the boundary (original-array index) to the post-removal index
    // the reducer expects: removing the dragged row shifts later boundaries.
    const boundary = target.position === 'before' ? targetIdx : targetIdx + 1;
    const toIndex = boundary > from ? boundary - 1 : boundary;
    if (toIndex === from) return;
    dispatch(moveResourceCommand(draggedId, toIndex));
  };

  // Auto-scroll: while a drag is in flight and the pointer is near the top or
  // bottom edge of the scroll container, scroll continuously. One rAF loop
  // per drag (mirrors TaskTable).
  useEffect(() => {
    if (!draggedResourceId) return;
    const onMove = (e: MouseEvent) => {
      pointerY.current = e.clientY;
    };
    window.addEventListener('mousemove', onMove);

    const tick = () => {
      const el = scrollRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const edge = ROW_HEIGHT * 2;
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
  }, [draggedResourceId]);

  const commitAndStop = (resource: Resource, field: EditableField, value: string) => {
    commitField(resource, field, value);
    stopEditing();
  };

  /** Shared onKeyDown for the three inline-edit inputs. */
  const onEditInputKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    resource: Resource,
    field: EditableField,
  ) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitAndStop(resource, field, (e.target as HTMLInputElement).value);
      (
        scrollRef.current?.querySelector(
          `[data-resource-id="${resource.id}"]`,
        ) as HTMLElement | null
      )?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stopEditing();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitField(resource, field, (e.target as HTMLInputElement).value);
      tabField(resource.id, field, e.shiftKey);
    }
  };

  return (
    <>
      <div
        data-resource-list
        className="relative flex shrink-0 flex-col border-r border-border bg-bg-elevated"
        style={{ width: tableWidth }}
      >
        {/* §4.1: drag the right edge to resize the resource panel; double-click
            resets to the default. The handle straddles the border. */}
        <ResizeHandle
          ariaLabel={t('layout.resizePanel')}
          title={t('layout.resetPanelWidth')}
          dataResize="resource-panel"
          className="-right-1"
          onResizeStart={(e) =>
            startPointerResize(e, { startWidth: panelWidth, onResize: setPanelWidth })
          }
          onReset={() => setPanelWidth(DEFAULT_PANEL_WIDTHS.resource)}
        />
        <div
          className="shrink-0 border-b border-border bg-bg-elevated text-xs font-semibold text-fg-muted"
          style={{ height: HEADER_HEIGHT }}
        >
          {/* Resource summary columns stay in the fixed view header. The first
              cell carries the expand/collapse-all buttons (bulk drill-down
              navigation — ephemeral, not undoable). */}
          <div className="grid h-full items-center" style={{ gridTemplateColumns: gridTemplate }}>
            <div className="flex h-full items-center gap-0.5 border-r border-border pr-1">
              {/* Align the label with the name text (grip + chevron + avatar). */}
              <span aria-hidden className="w-16 shrink-0" />
              <span className="truncate">{t('resource.columnName')}</span>
              <span className="flex-1" />
              <button
                type="button"
                data-testid="expand-all-resources"
                aria-label={t('resource.expandAll')}
                title={t('resource.expandAll')}
                onClick={expandAllResources}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-fg-muted outline-none transition-colors hover:bg-bg hover:text-fg focus-visible:ring-1 focus-visible:ring-primary/40"
              >
                <ChevronsUpDown size={13} aria-hidden />
              </button>
              <button
                type="button"
                data-testid="collapse-all-resources"
                aria-label={t('resource.collapseAll')}
                title={t('resource.collapseAll')}
                onClick={collapseAllResources}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-fg-muted outline-none transition-colors hover:bg-bg hover:text-fg focus-visible:ring-1 focus-visible:ring-primary/40"
              >
                <ChevronsDownUp size={13} aria-hidden />
              </button>
            </div>
            <ResizableHeaderCell
              label={t('resource.columnRole')}
              width={roleWidth}
              defaultWidth={DEFAULT_COLUMN_WIDTHS.role}
              dataResize="resource-col-role"
              className="flex h-full items-center"
              onWidthChange={(w) => setColumnWidth('role', w)}
            />
            <ResizableHeaderCell
              label={t('resource.columnCapacity')}
              width={capacityWidth}
              defaultWidth={DEFAULT_COLUMN_WIDTHS.capacity}
              dataResize="resource-col-capacity"
              className="flex h-full items-center"
              onWidthChange={(w) => setColumnWidth('capacity', w)}
            />
            <div className="px-1 text-center" aria-label={t('resource.columnActions')}>
              ⋯
            </div>
          </div>
        </div>
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto" onScroll={onScroll}>
          {/* §5.2: zero-resource hint inside the list body. The bottom "+ 新增资源"
              button is always visible and is the real CTA; this panel just
              explains the state so the blank list isn't confusing. The right
              load canvas stays empty (no fake data) per plan §5.2. */}
          {flatRows.length === 0 ? (
            <EmptyState
              title={t('empty.noResourceTitle')}
              description={t('empty.noResourceHint')}
            />
          ) : (
            <div
              role="treegrid"
              aria-label={t('resource.listAriaLabel')}
              className="relative"
              style={{ height: Math.max(flatRows.length * ROW_HEIGHT, 0) }}
            >
              {flatRows.map((row) => {
                const y = row.yIndex * ROW_HEIGHT;
                if (row.kind === 'resource') {
                  const r = file.resources.find((res) => res.id === row.resourceId);
                  if (!r) return null;
                  const selected = selectedResourceId === r.id;
                  const taskCount = tasksByRes.map.get(r.id)?.length ?? 0;
                  const expanded = expandedResourceIds.has(r.id);
                  const activeField = activeFieldOf(r.id);
                  const isDragged = draggedResourceId === r.id;
                  const isDropHere = dropTarget?.rowId === r.id;
                  return (
                    <div
                      key={`r-${r.id}`}
                      role="row"
                      tabIndex={0}
                      aria-selected={selected}
                      aria-level={1}
                      aria-expanded={taskCount > 0 ? expanded : undefined}
                      data-resource-id={r.id}
                      data-keyboard-row-index={row.yIndex}
                      onClick={() => setSelectedResourceId(r.id)}
                      onDoubleClick={(e) => {
                        // Modifier-double-click is ambiguous; only plain
                        // double-click drills down (a person's "detail" is
                        // their task list — the resource view's twin of the
                        // task view's double-click-opens-drawer rule).
                        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                        setSelectedResourceId(r.id);
                        if (taskCount > 0) toggleResourceExpanded(r.id);
                      }}
                      onKeyDown={(e) => onRowKeyDown(e, row)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedResourceId(r.id);
                        openResourceContextMenu(r.id, e.clientX, e.clientY);
                      }}
                      onDragOver={(e) => onRowDragOver(e, r.id)}
                      onDragLeave={onRowDragLeave}
                      onDrop={onRowDrop}
                      style={{
                        height: ROW_HEIGHT,
                        transform: `translateY(${y}px)`,
                        gridTemplateColumns: gridTemplate,
                      }}
                      className={cn(
                        'group/row absolute left-0 right-0 grid cursor-pointer items-center border-b border-border text-xs outline-none',
                        'hover:bg-bg',
                        selected && 'bg-bg ring-1 ring-inset ring-primary',
                        isDragged && 'opacity-40',
                      )}
                    >
                      {/* Insertion line for before/after drops. */}
                      {isDropHere && (
                        <div
                          aria-hidden
                          className="pointer-events-none absolute left-1 right-0 bg-primary"
                          style={{
                            height: 2,
                            top: dropTarget!.position === 'before' ? -1 : ROW_HEIGHT - 1,
                            zIndex: 5,
                          }}
                        />
                      )}
                      <div className="flex h-full min-w-0 items-center overflow-hidden border-r border-border">
                        {/* Drag grip — the ONLY drag source on the row. The
                         * 18px slot is always reserved and the icon only
                         * animates opacity: hovering can never shift the
                         * avatar, name, or chevron. Clicks are isolated —
                         * grabbing here neither selects nor drills down. */}
                        <div
                          data-testid="row-drag-handle"
                          draggable
                          onDragStart={(e) => onGripDragStart(e, r.id)}
                          onDragEnd={cleanupDrag}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          title={t('resource.dragHint')}
                          className="flex h-full w-[18px] shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
                        >
                          <GripVertical
                            size={12}
                            aria-hidden
                            className="text-fg-muted/60 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100 hover:text-fg"
                          />
                        </div>
                        {/* Chevron slot reserved on every row so avatars and
                         * names stay strictly aligned across rows. */}
                        {taskCount > 0 ? (
                          <button
                            type="button"
                            data-testid="expand-toggle"
                            aria-expanded={expanded}
                            aria-label={expanded ? t('resource.collapse') : t('resource.expand')}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleResourceExpanded(r.id);
                            }}
                            onDoubleClick={(e) => e.stopPropagation()}
                            className="flex h-5 w-4 shrink-0 items-center justify-center rounded-sm text-fg-muted outline-none transition-colors hover:bg-bg hover:text-fg focus-visible:ring-1 focus-visible:ring-primary/40"
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        ) : (
                          <span aria-hidden className="w-4 shrink-0" />
                        )}
                        {/* Person avatar — the resource view's identity
                         * marker (people-centric counterpart of the task
                         * tree's chevron + semibold parents). */}
                        <span
                          aria-hidden
                          className={cn(
                            'flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full text-[10px] font-semibold',
                            avatarColorOf(r.name),
                          )}
                        >
                          {initialsOf(r.name)}
                        </span>
                        <div className="flex min-w-0 flex-1 items-center pl-1.5 pr-2">
                          {activeField === 'name' ? (
                            <input
                              autoFocus
                              data-testid="resource-name-input"
                              defaultValue={r.name}
                              // Commit-on-blur matches TaskTable's F2 flow. The
                              // guard avoids a double-dispatch when Enter/Tab
                              // already committed: those handlers move/null the
                              // editing cell before blur fires.
                              onBlur={(e) => {
                                if (
                                  editingCell.current?.resourceId === r.id &&
                                  editingCell.current.field === 'name'
                                ) {
                                  commitAndStop(r, 'name', e.target.value);
                                }
                              }}
                              onKeyDown={(e) => onEditInputKeyDown(e, r, 'name')}
                              onDoubleClick={(e) => e.stopPropagation()}
                              className="h-5 min-w-0 flex-1 rounded-sm bg-transparent px-0.5 outline-none"
                            />
                          ) : (
                            <span
                              data-testid="resource-name"
                              className={cn(
                                'min-w-0 flex-1 truncate font-medium',
                                !r.name && 'text-fg-muted',
                              )}
                              title={r.name}
                            >
                              {r.name || t('resource.placeholderName')}
                            </span>
                          )}
                          {/* Collapsed resources quantify their hidden tasks
                           * (Notion-style count chip) so nothing is silently
                           * invisible; expanded rows show the lanes anyway. */}
                          {!expanded && taskCount > 0 && activeField === null && (
                            <span
                              data-testid="task-count"
                              className="ml-1.5 shrink-0 rounded bg-bg px-1 text-[10px] leading-4 tabular-nums text-fg-muted"
                            >
                              {t('resource.taskCount', { count: taskCount })}
                            </span>
                          )}
                        </div>
                      </div>
                      {activeField === 'role' ? (
                        <input
                          autoFocus
                          data-testid="resource-role-input"
                          defaultValue={r.role ?? ''}
                          onBlur={(e) => {
                            if (
                              editingCell.current?.resourceId === r.id &&
                              editingCell.current.field === 'role'
                            ) {
                              commitAndStop(r, 'role', e.target.value);
                            }
                          }}
                          onKeyDown={(e) => onEditInputKeyDown(e, r, 'role')}
                          onDoubleClick={(e) => e.stopPropagation()}
                          className="truncate bg-transparent px-2 text-fg-muted outline-none"
                        />
                      ) : (
                        <div
                          data-testid="resource-role"
                          className="truncate border-r border-border px-2 text-fg-muted"
                          title={r.role ?? undefined}
                        >
                          {r.role || '—'}
                        </div>
                      )}
                      {/* §5.3: capacity unit made explicit — the stored value
                          is 0-1 but the cell shows ×100, so a bare number
                          would be ambiguous (the legend already labels with
                          %). */}
                      {activeField === 'capacity' ? (
                        <div className="flex items-center overflow-hidden border-r border-border px-1">
                          <input
                            autoFocus
                            type="number"
                            min={0}
                            max={100}
                            step={10}
                            data-testid="resource-capacity-input"
                            aria-label={`${t('resource.columnCapacity')}%`}
                            defaultValue={Math.round((r.capacity ?? 1) * 100)}
                            onBlur={(e) => {
                              if (
                                editingCell.current?.resourceId === r.id &&
                                editingCell.current.field === 'capacity'
                              ) {
                                commitAndStop(r, 'capacity', e.target.value);
                              }
                            }}
                            onKeyDown={(e) => onEditInputKeyDown(e, r, 'capacity')}
                            onDoubleClick={(e) => e.stopPropagation()}
                            className="min-w-0 flex-1 bg-transparent px-1 text-right text-fg-muted outline-none"
                          />
                          <span className="shrink-0 text-[10px] text-fg-muted">%</span>
                        </div>
                      ) : (
                        <div
                          data-testid="resource-capacity"
                          className="border-r border-border px-2 text-right tabular-nums text-fg-muted"
                        >
                          {Math.round((r.capacity ?? 1) * 100)}%
                        </div>
                      )}
                      <button
                        type="button"
                        data-testid="resource-delete"
                        title={t('resource.delete')}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeResource(r.id);
                        }}
                        className="mx-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-fg-muted opacity-0 transition-opacity hover:text-destructive group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
                      >
                        <X size={12} aria-hidden />
                      </button>
                    </div>
                  );
                }
                if (row.kind === 'task-header') {
                  return (
                    <div
                      key={`th-${row.resourceId}`}
                      role="row"
                      aria-label={t('table.taskColumnsHeader')}
                      style={{
                        height: ROW_HEIGHT,
                        transform: `translateY(${y}px)`,
                        gridTemplateColumns: taskGridTemplate,
                      }}
                      className="absolute left-0 right-0 grid items-center border-b border-border bg-bg text-[11px] font-semibold text-fg-muted"
                    >
                      <div className="border-r border-border/70" />
                      <div className="border-r border-border/70 px-1">{t('table.columnWbs')}</div>
                      <div className="border-r border-border/70 px-2">{t('table.columnName')}</div>
                      <div className="border-r border-border/70 px-1 text-right">
                        {t('table.columnDuration')}
                      </div>
                      <div className="border-r border-border/70 px-1 text-right">
                        {t('table.columnEffort')}
                      </div>
                      <div className="px-1 text-right">{t('table.columnProgress')}</div>
                    </div>
                  );
                }

                // Task lane row — mirrors TaskTable's leaf row (reserved
                // chevron slot, tabular WBS, semibold-less medium name).
                const task = row.task;
                const selected = selectedTaskIdInResource === task.id;
                const wbs = tasksByRes.wbsByTaskId.get(task.id) ?? '';
                return (
                  <div
                    key={`t-${row.resourceId}-${task.id}`}
                    role="row"
                    tabIndex={0}
                    aria-selected={selected}
                    aria-level={2}
                    data-resource-task-id={task.id}
                    data-keyboard-row-index={row.yIndex}
                    onClick={() => selectFlatRow(row)}
                    onKeyDown={(e) => onRowKeyDown(e, row)}
                    onDoubleClick={() => {
                      // TaskDrawer reads file.viewState.selectedTaskId, so set it
                      // at open time. The lane highlight stays on the resource-view
                      // selection (selectedTaskIdInResource), independent per G19.
                      // §4.6: selection is ephemeral now; selectSingle mirrors the
                      // anchor into file.viewState.selectedTaskId for the drawer.
                      useViewStore.getState().selectSingle(task.id);
                      openDrawer();
                    }}
                    style={{
                      height: ROW_HEIGHT,
                      transform: `translateY(${y}px)`,
                      gridTemplateColumns: taskGridTemplate,
                    }}
                    className={cn(
                      'absolute left-0 right-0 grid cursor-pointer items-center border-b border-border text-xs outline-none',
                      'hover:bg-bg',
                      selected && 'bg-bg ring-1 ring-inset ring-primary',
                    )}
                  >
                    {/* Reserved empty slot where TaskTable puts the chevron —
                     * keeps the lane grid aligned with the task tree. */}
                    <div aria-hidden className="flex items-center justify-center text-fg-muted">
                      <span className="h-full w-[14px] border-r border-border/60" />
                    </div>
                    <div className="overflow-hidden border-r border-border px-1 text-right tabular-nums text-fg-muted">
                      {wbs}
                    </div>
                    <div className="min-w-0 truncate border-r border-border px-2 font-medium">
                      {task.isMilestone && <span className="mr-1 text-warning">◆</span>}
                      {task.name || t('table.placeholderName')}
                    </div>
                    <div className="border-r border-border px-1 text-right tabular-nums text-fg-muted">
                      {task.isMilestone ? '—' : `${task.duration}d`}
                    </div>
                    <div className="border-r border-border px-1 text-right tabular-nums text-fg-muted">
                      {(() => {
                        const pd = computeAssignmentPersonDays(
                          task,
                          row.resourceId,
                          file.resources,
                          cal,
                        );
                        return pd > 0 ? `${pd}` : '—';
                      })()}
                    </div>
                    <div className="px-1 text-right tabular-nums text-fg-muted">
                      {task.progress}%
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <button
          data-testid="add-resource"
          className="flex items-center gap-1 border-t border-border px-2 py-1 text-left text-xs text-primary hover:bg-bg"
          onClick={addResource}
        >
          <Plus size={12} aria-hidden />
          {t('resource.add')}
        </button>
      </div>
      {confirmDeleteResourceId && (
        <DeleteResourceConfirm
          resourceId={confirmDeleteResourceId}
          onClose={() => setConfirmDeleteResourceId(null)}
        />
      )}
    </>
  );
}
