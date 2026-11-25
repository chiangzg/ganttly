/**
 * Priority matrix — the right-hand pane of the `priority` view mode
 * (priority-matrix spec §4, §5).
 *
 *   ┌ view bar: triage summary · assignee filter · show completed ┐
 *   ├ to-triage tray: every leaf task without a priority             │
 *   ├ 2×2 quadrants: P1 紧急且重要 / P2 / P3 / P4                     │
 *
 * It shares the task tree on the left with the task view: one selection set,
 * one search box, and picking a card lines the tree up with it. All the rules
 * live in `lib/priorityMatrix`; this component only renders and wires them.
 *
 * Drag & drop uses the native HTML5 mechanism TaskTable/ResourceList use (no
 * library). Unlike the tree, where only the grip drags so clicks never turn
 * into accidental drags, the WHOLE card is the drag source: here dragging is
 * the primary action. Each bucket (tray or quadrant) is a drop target.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowUpDown, Check, ChevronUp, Inbox, Plus } from 'lucide-react';
import { TASK_PRIORITIES } from '@ganttly/schema';
import type { Task, TaskPriority } from '@ganttly/schema';
import { useProjectStore } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { computeSelectionOnPointerDown } from '@/lib/selection';
import { todayISO } from '@/engine/layout';
import { resolveCalendar } from '@/lib/calendar';
import { revealTask } from '@/lib/revealTask';
import { PRIORITY_TAG, PRIORITY_TAG_CLASS } from '@/lib/priority';
import { setTaskPriority } from '@/lib/setTaskPriority';
import {
  bucketMatrixTasks,
  matrixVisibleIds,
  resolvePriorityDrop,
  MATRIX_SORT_MODES,
} from '@/lib/priorityMatrix';
import type { MatrixBucket, MatrixCard, MatrixSortMode } from '@/lib/priorityMatrix';
import { PriorityCard } from './PriorityCard';
import { DeleteTaskConfirm } from './DeleteTaskConfirm';
import { EmptyState } from './ui/EmptyState';
import { cn } from '@/lib/cn';

/** React's synthetic event types, aliased to keep the handler signatures short. */
type MouseHandler = (task: Task, event: React.MouseEvent<HTMLDivElement>) => void;

const DROP_ZONE_CLASS = 'transition-[background-color,box-shadow] duration-150';

/** Vertical-only reveal: the task tree follows, the task view keeps its place. */
function revealInTree(taskId: string): void {
  revealTask(taskId, { skipIfVisible: true, horizontal: false });
}

export function PriorityMatrix() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const searchQuery = useViewStore((s) => s.searchQuery);
  const matrixAssignee = useViewStore((s) => s.matrixAssignee);
  const setMatrixAssignee = useViewStore((s) => s.setMatrixAssignee);
  const matrixShowDone = useViewStore((s) => s.matrixShowDone);
  const toggleMatrixShowDone = useViewStore((s) => s.toggleMatrixShowDone);
  const matrixSort = useViewStore((s) => s.matrixSort);
  const setMatrixSort = useViewStore((s) => s.setMatrixSort);
  const matrixTrayCollapsed = useViewStore((s) => s.matrixTrayCollapsed);
  const toggleMatrixTrayCollapsed = useViewStore((s) => s.toggleMatrixTrayCollapsed);
  // Subscribed at card granularity so Cmd/Ctrl and Shift clicks repaint at once.
  const selectedTaskIds = useViewStore((s) => s.selectedTaskIds);
  const anchorTaskId = useViewStore((s) => s.anchorTaskId);

  const cal = useMemo(() => resolveCalendar(file.calendar), [file.calendar]);
  // Recomputed on every render: a view left open past midnight must not keep
  // hinting against yesterday's "today" on the next edit.
  const today = todayISO();
  // A filter naming a resource that has since been deleted falls back to "all"
  // instead of silently hiding every card.
  const assigneeFilter =
    matrixAssignee === 'all' ||
    matrixAssignee === 'none' ||
    file.resources.some((r) => r.id === matrixAssignee)
      ? matrixAssignee
      : 'all';

  const model = useMemo(
    () =>
      bucketMatrixTasks(
        file,
        {
          searchQuery,
          assignee: assigneeFilter,
          showDone: matrixShowDone,
          sort: matrixSort,
        },
        today,
      ),
    [file, searchQuery, assigneeFilter, matrixShowDone, matrixSort, today],
  );
  const resourceById = useMemo(
    () => new Map(file.resources.map((r) => [r.id, r] as const)),
    [file.resources],
  );
  // Reading order (tray first) — the sequence Shift-click ranges over.
  const visibleIds = useMemo(() => matrixVisibleIds(model), [model]);
  const triagedCount = TASK_PRIORITIES.reduce((sum, p) => sum + model.quadrants[p].length, 0);

  const rootRef = useRef<HTMLDivElement>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // ---- Drag & drop ----------------------------------------------------------
  // The live drag lives in a ref: `dragover` fires far more often than React
  // renders. The two state values below only drive what is painted.
  const dragRef = useRef<{ taskId: string; cancelled: boolean } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overBucket, setOverBucket] = useState<MatrixBucket | null>(null);

  // Escape cancels an in-flight drag (same as the task tree). A window listener
  // because native drag suppresses React's key handling on the source element.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragRef.current) return;
      dragRef.current.cancelled = true;
      setOverBucket(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDraggingId(null);
    setOverBucket(null);
  }, []);

  const onCardDragStart: (task: Task, event: React.DragEvent<HTMLDivElement>) => void = (
    task,
    event,
  ) => {
    // A drag always moves exactly THIS card (spec §4.5). Collapse a multi-
    // selection right away so the tree highlight and the batch bar agree.
    const cur = useViewStore.getState();
    if (cur.selectedTaskIds.size !== 1 || !cur.selectedTaskIds.has(task.id)) {
      cur.selectSingle(task.id);
    }
    dragRef.current = { taskId: task.id, cancelled: false };
    event.dataTransfer.setData('text/plain', task.id);
    event.dataTransfer.effectAllowed = 'move';
    // One tick later: the browser snapshots the drag image right after
    // dragstart, and dimming the source synchronously would dim the ghost too.
    setTimeout(() => {
      if (dragRef.current?.taskId === task.id) setDraggingId(task.id);
    }, 0);
  };

  const onBucketDragOver = (bucket: MatrixBucket, event: React.DragEvent<HTMLElement>) => {
    const drag = dragRef.current;
    // Not our drag (a task-tree grip passing over the matrix): not a target.
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = drag.cancelled ? 'none' : 'move';
    if (!drag.cancelled) setOverBucket(bucket);
  };

  const onBucketDragLeave = (bucket: MatrixBucket, event: React.DragEvent<HTMLElement>) => {
    // Only when the pointer truly leaves the bucket — crossing between its
    // children fires dragleave too and must not flicker the highlight.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setOverBucket((prev) => (prev === bucket ? null : prev));
  };

  const onBucketDrop = (bucket: MatrixBucket, event: React.DragEvent<HTMLElement>) => {
    const drag = dragRef.current;
    endDrag();
    if (!drag || drag.cancelled) return;
    event.preventDefault();
    const task = useProjectStore.getState().file.tasks.find((x) => x.id === drag.taskId);
    if (!task) return;
    // setTaskPriority dispatches nothing when the task is already in this bucket.
    if (setTaskPriority(drag.taskId, resolvePriorityDrop(bucket, task).priority)) {
      revealInTree(drag.taskId);
    }
  };

  const bucketHandlers = (bucket: MatrixBucket) => ({
    onDragOver: (event: React.DragEvent<HTMLElement>) => onBucketDragOver(bucket, event),
    onDragLeave: (event: React.DragEvent<HTMLElement>) => onBucketDragLeave(bucket, event),
    onDrop: (event: React.DragEvent<HTMLElement>) => onBucketDrop(bucket, event),
  });

  // ---- Selection & keyboard -------------------------------------------------
  const onCardMouseDown: MouseHandler = (task, event) => {
    if (event.button !== 0) return;
    const cur = useViewStore.getState();
    const next = computeSelectionOnPointerDown(
      task.id,
      { ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey },
      { ids: cur.selectedTaskIds, anchor: cur.anchorTaskId },
      visibleIds,
    );
    cur.setSelection(next);
    // Card → tree: expand collapsed ancestors and scroll the row into view.
    if (next.ids.has(task.id)) revealInTree(task.id);
  };

  const focusCard = (taskId: string) => {
    rootRef.current?.querySelector<HTMLElement>(`[data-matrix-task-id="${taskId}"]`)?.focus();
  };

  const onCardKeyDown = (task: Task, event: React.KeyboardEvent<HTMLDivElement>) => {
    const view = useViewStore.getState();
    if (event.key === 'Enter') {
      event.preventDefault();
      view.selectSingle(task.id);
      view.openDrawer();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Same split as the task tree: a multi-selection goes through the batch
      // confirm (owned by TaskTable, which is mounted in this view); a single
      // selection gets the per-task confirm.
      event.preventDefault();
      if (view.selectedTaskIds.size > 1) view.requestBatchDelete();
      else setDeleteTargetId(view.anchorTaskId ?? task.id);
      return;
    }
    if (event.key === 'Escape') {
      // During a drag the window listener above owns Escape (it cancels).
      if (dragRef.current) return;
      event.preventDefault();
      view.clearSelection();
      return;
    }
    if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      view.toggleSelected(task.id);
      return;
    }
    const vertical =
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey;
    if (vertical) {
      event.preventDefault();
      const index = visibleIds.indexOf(task.id);
      const next = visibleIds[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        view.selectSingle(next);
        focusCard(next);
      }
    }
  };

  const onCardDoubleClick = (task: Task) => {
    useViewStore.getState().selectSingle(task.id);
    useViewStore.getState().openDrawer();
  };

  const onCardContextMenu: MouseHandler = (task, event) => {
    event.preventDefault();
    // The task menu is single-task: plain-select the clicked card first.
    useViewStore.getState().selectSingle(task.id);
    useViewStore.getState().openContextMenu(task.id, event.clientX, event.clientY);
  };

  /** A press on a bucket's empty area (not on a card) clears the selection. */
  const onBucketBlankMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) useViewStore.getState().clearSelection();
  };

  const renderCard = (card: MatrixCard) => (
    <PriorityCard
      key={card.task.id}
      task={card.task}
      wbsNumber={card.wbsNumber}
      today={today}
      cal={cal}
      resourceById={resourceById}
      selected={selectedTaskIds.has(card.task.id)}
      anchor={anchorTaskId === card.task.id}
      dragging={draggingId === card.task.id}
      onCardMouseDown={onCardMouseDown}
      onCardDoubleClick={onCardDoubleClick}
      onCardContextMenu={onCardContextMenu}
      onCardKeyDown={onCardKeyDown}
      onCardDragStart={onCardDragStart}
      onCardDragEnd={endDrag}
    />
  );

  const countChip = (
    <span className="shrink-0 rounded-full bg-bg px-[7px] text-[11px] leading-[18px] tabular-nums text-fg-muted">
      {model.tray.length}
    </span>
  );

  const renderQuadrant = (n: TaskPriority) => {
    const cards = model.quadrants[n];
    const q = `var(--color-priority-${n})`;
    const over = overBucket === n;
    const label = `${PRIORITY_TAG[n]} ${t(`priority.title${n}`)}`;
    return (
      <section
        data-matrix-bucket={n}
        aria-label={label}
        {...bucketHandlers(n)}
        className={cn(
          'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated',
          DROP_ZONE_CLASS,
        )}
        style={
          over
            ? {
                backgroundColor: `rgb(${q} / 0.07)`,
                boxShadow: `inset 0 0 0 2px rgb(${q} / 0.8)`,
              }
            : undefined
        }
      >
        {/* Title band: 8% quadrant tint, a 3px accent on the left edge. */}
        <div
          className="flex h-[34px] shrink-0 items-center gap-1.5 pl-2.5 pr-1.5"
          style={{
            backgroundColor: `rgb(${q} / 0.08)`,
            borderBottom: `1px solid rgb(${q} / 0.2)`,
            boxShadow: `inset 3px 0 0 rgb(${q})`,
          }}
        >
          <span
            data-testid="quadrant-tag"
            className={cn(
              'shrink-0 rounded px-1 text-[10px] font-bold leading-4 tabular-nums',
              PRIORITY_TAG_CLASS[n],
            )}
          >
            {PRIORITY_TAG[n]}
          </span>
          <span className="shrink-0 text-xs font-semibold whitespace-nowrap">
            {t(`priority.title${n}`)}
          </span>
          <span className="min-w-0 truncate text-[11px] text-fg-muted">
            {t(`priority.hint${n}`)}
          </span>
          <span
            data-testid="quadrant-count"
            className="ml-auto shrink-0 rounded-full bg-bg px-[7px] text-[11px] leading-[18px] tabular-nums text-fg-muted"
          >
            {cards.length}
          </span>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label={t('priority.sortAria', { tag: PRIORITY_TAG[n] })}
                title={t('priority.sortLabel')}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-muted outline-none transition hover:bg-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/35"
              >
                <ArrowUpDown size={12} aria-hidden />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-40 min-w-44 rounded-xl border border-border bg-bg-elevated p-1.5 shadow-xl"
              >
                <DropdownMenu.RadioGroup
                  value={matrixSort[n]}
                  onValueChange={(value) => setMatrixSort(n, value as MatrixSortMode)}
                >
                  {MATRIX_SORT_MODES.map((mode) => (
                    <DropdownMenu.RadioItem
                      key={mode}
                      value={mode}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-bg"
                    >
                      {t(`priority.sort.${mode}`)}
                      <DropdownMenu.ItemIndicator className="ml-auto">
                        <Check size={14} className="text-primary" />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto p-1.5"
          onMouseDown={onBucketBlankMouseDown}
        >
          {cards.map(renderCard)}
          {cards.length === 0 && (
            <div className="pointer-events-none flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-border bg-bg-elevated/50 px-3 py-4 text-center text-xs text-fg-muted">
              <span>
                {model.isFiltered ? t('priority.emptyFiltered') : t('priority.emptyQuadrant')}
              </span>
              {!model.isFiltered && (
                <span className="text-[11px] opacity-80">
                  {t('priority.emptyQuadrantSet', {
                    tag: PRIORITY_TAG[n],
                    title: t(`priority.title${n}`),
                  })}
                </span>
              )}
            </div>
          )}
        </div>
      </section>
    );
  };

  /**
   * Axis caption (spec §5.6). For the vertical ones the wrapper does the
   * centring — a plain horizontal flex box — and an inner block carries the
   * vertical writing mode. Centring raw text straight inside a vertical-rl
   * flex container proved fragile (Chromium was seen dropping the first glyph).
   */
  const axis = (text: string, vertical = false) => (
    <div aria-hidden className="flex items-center justify-center">
      <span
        className={cn(
          'text-[11px] tracking-wider text-fg-muted',
          vertical && 'block [writing-mode:vertical-rl]',
        )}
      >
        {text}
      </span>
    </div>
  );

  const summary = model.isFiltered
    ? t('priority.summaryFiltered', {
        shown: triagedCount + model.tray.length,
        total: model.leafTotal,
      })
    : t('priority.summary', { triaged: triagedCount, untriaged: model.tray.length });

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label={t('priority.matrixLabel')}
      data-priority-matrix
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {/* ---- View bar ---- */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <span
          data-testid="matrix-summary"
          className="shrink-0 text-[11px] tabular-nums text-fg-muted"
        >
          {summary}
        </span>
        <div className="min-w-2 flex-1" />
        <select
          aria-label={t('priority.assigneeFilter')}
          value={assigneeFilter}
          onChange={(event) => setMatrixAssignee(event.target.value)}
          className="h-7 max-w-[150px] rounded-md border border-border bg-bg-elevated px-1.5 text-xs text-fg outline-none focus-visible:border-primary"
        >
          <option value="all">{t('priority.assigneeAll')}</option>
          <option value="none">{t('priority.assigneeNone')}</option>
          {file.resources.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={matrixShowDone}
          onClick={toggleMatrixShowDone}
          className={cn(
            'h-7 shrink-0 whitespace-nowrap rounded-md px-2 text-[11px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-primary/35',
            matrixShowDone
              ? 'bg-primary/10 text-primary hover:bg-primary/15'
              : 'text-fg-muted hover:bg-bg hover:text-fg',
          )}
        >
          {t('priority.showDone')}
        </button>
      </div>

      {file.tasks.length === 0 ? (
        // A project without tasks has nothing to triage. The create entry lives
        // in the task tree's own bar (next to the list), so just point there.
        <EmptyState
          icon={<Plus size={22} />}
          title={t('priority.emptyProjectTitle')}
          description={t('priority.emptyProjectHint')}
          className="m-2"
        />
      ) : (
        <>
          {/* ---- To-triage tray ---- */}
          <section
            data-matrix-bucket="tray"
            aria-label={t('priority.trayTitle')}
            {...bucketHandlers('tray')}
            className={cn(
              'flex max-h-[34%] shrink-0 flex-col border-b border-border',
              DROP_ZONE_CLASS,
            )}
            style={
              overBucket === 'tray'
                ? {
                    backgroundColor: 'rgb(var(--color-primary) / 0.06)',
                    boxShadow: 'inset 0 -2px 0 rgb(var(--color-primary) / 0.7)',
                  }
                : undefined
            }
          >
            {model.tray.length === 0 ? (
              <div className="flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-fg-muted">
                <Inbox size={14} aria-hidden />
                <span className="text-xs font-semibold text-fg">{t('priority.trayTitle')}</span>
                {countChip}
                <span className="min-w-0 truncate text-[11px]">{t('priority.trayEmptyHint')}</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={toggleMatrixTrayCollapsed}
                aria-expanded={!matrixTrayCollapsed}
                aria-label={
                  matrixTrayCollapsed ? t('priority.trayExpand') : t('priority.trayCollapse')
                }
                className="flex h-8 w-full shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-left text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
              >
                <Inbox size={14} aria-hidden />
                <span className="text-xs font-semibold text-fg">{t('priority.trayTitle')}</span>
                {countChip}
                <span className="min-w-0 truncate text-[11px]">{t('priority.trayHint')}</span>
                <ChevronUp
                  size={14}
                  aria-hidden
                  className={cn(
                    'ml-auto shrink-0 transition-transform',
                    matrixTrayCollapsed && 'rotate-180',
                  )}
                />
              </button>
            )}
            {!matrixTrayCollapsed && model.tray.length > 0 && (
              <div
                role="listbox"
                aria-multiselectable="true"
                aria-label={t('priority.trayTitle')}
                className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
                onMouseDown={onBucketBlankMouseDown}
              >
                <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-[3px]">
                  {model.tray.map(renderCard)}
                </div>
              </div>
            )}
          </section>

          {/* ---- 2×2 grid. Row = importance (top important), column = urgency (left urgent). ---- */}
          <div className="grid min-h-0 flex-1 grid-cols-[26px_minmax(0,1fr)_minmax(0,1fr)] grid-rows-[22px_minmax(0,1fr)_minmax(0,1fr)] gap-x-2 pb-2 pr-2">
            <div aria-hidden />
            {axis(t('priority.axisUrgent'))}
            {axis(t('priority.axisNotUrgent'))}
            {axis(t('priority.axisImportant'), true)}
            {renderQuadrant(1)}
            {renderQuadrant(2)}
            {axis(t('priority.axisNotImportant'), true)}
            {renderQuadrant(3)}
            {renderQuadrant(4)}
          </div>
        </>
      )}

      {deleteTargetId && (
        <DeleteTaskConfirm taskId={deleteTargetId} onClose={() => setDeleteTargetId(null)} />
      )}
    </div>
  );
}
