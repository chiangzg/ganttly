/**
 * Scene assembly (PRD §5.2).
 *
 * Transforms a `GanttlyFile` + view state into a renderable `Scene`. This is
 * the only function the React layer calls before invoking the renderer.
 *
 * Responsibilities:
 * - Build the visible row list (flatten tree + apply collapse state)
 * - Virtualise rows (drop those outside the viewport)
 * - Compute arrow geometry from dependency specs
 * - Resolve holidays within the visible date range
 */
import type { GanttlyFile, Holiday, Task } from '@ganttly/schema';
import type { Scene, TaskRow, ArrowSpec } from '../render/types';
import { HEADER_HEIGHT, ROW_HEIGHT, dateToPixel, dayDiff, pixelsPerDay } from '../layout';
import { buildTree, flattenVisible } from './tree';
import { computeCriticalPath } from '@/lib/cpm';
import { computeAllRollups } from '@/lib/summary';
import { checkConstraintConflicts } from '@/lib/schedule';
import { resolveCalendar } from '@/lib/calendar';
import { getCalendar } from '@ganttly/calendar-data';

export interface AssembleOptions {
  viewportWidth: number;
  viewportHeight: number;
  today: string;
  /** Set of task ids that are on the critical path (M3). */
  criticalTaskIds?: ReadonlySet<string>;
}

export function assembleScene(file: GanttlyFile, opts: AssembleOptions): Scene {
  const tree = buildTree(file.tasks);
  const collapsed = new Set(file.viewState.collapsedTaskIds);
  const visible = flattenVisible(tree, collapsed);

  // Pre-compute rollup values for all summary tasks. Used for both CPM input
  // (so critical-path sees a summary's true aggregated start/duration) and for
  // canvas row rendering (especially important during drag mid-states where
  // the underlying Task data may be momentarily stale).
  const allRollups = computeAllRollups(file.tasks, file.resources);

  // Set of summary task ids, derived from the FULL task list (not just
  // visible rows) so that a summary whose children are all collapsed still
  // renders as a summary bar rather than degrading to a leaf.
  const summaryIds = buildSummaryIds(file.tasks);

  // Compute the critical path once per assembly. Cheap (<1ms for hundreds of
  // tasks) and gives every row the `isCritical` flag for highlighting.
  // Summary tasks are fed their rolled-up start/duration so CPM uses the
  // aggregated span (computeCriticalPath only reads start + duration, not end).
  const cpm = opts.criticalTaskIds
    ? null
    : computeCriticalPath(
        file.tasks.map((t) => {
          const r = allRollups.get(t.id);
          return r ? { ...t, start: r.start, duration: r.duration } : t;
        }),
        file.calendar,
      );
  const criticalIds = opts.criticalTaskIds ?? cpm?.criticalTaskIds ?? new Set<string>();

  // Detect constraint-vs-dependency conflicts (G4 — for arrow/row highlighting).
  const conflictIds = checkConstraintConflicts(
    file.tasks,
    resolveCalendar(getCalendar(file.calendar.id) ?? getCalendar('zh-CN')),
  );

  // Virtualise rows: drop rows above/below the visible scroll area.
  const firstVisibleRow = Math.max(0, Math.floor(file.viewState.scrollTop / ROW_HEIGHT) - 5);
  const lastVisibleRow = Math.min(
    visible.length,
    Math.ceil((file.viewState.scrollTop + opts.viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT) + 5,
  );
  const visibleSlice = visible.slice(firstVisibleRow, lastVisibleRow);

  const rows: TaskRow[] = visibleSlice.map((node) =>
    toTaskRow(
      node.task,
      node.depth,
      node.wbsNumber,
      criticalIds,
      summaryIds,
      allRollups,
      conflictIds,
    ),
  );

  const arrows = computeArrows(file, opts, visible, firstVisibleRow, criticalIds, conflictIds);

  return {
    zoom: file.viewState.zoom,
    originDate: originDateFor(file, opts),
    scrollLeft: file.viewState.scrollLeft,
    scrollTop: file.viewState.scrollTop,
    viewportWidth: opts.viewportWidth,
    viewportHeight: opts.viewportHeight,
    today: opts.today,
    holidays: holidaysInRange(file.calendar.holidays, opts),
    rows,
    arrows,
    showCriticalPath: file.viewState.showCriticalPath,
    selectedTaskId: file.viewState.selectedTaskId,
  };
}

function toTaskRow(
  task: Task,
  depth: number,
  wbs: string,
  criticalIds: ReadonlySet<string>,
  summaryIds: ReadonlySet<string>,
  allRollups: Map<string, { start: string; end: string; progress: number }>,
  conflictIds: ReadonlySet<string>,
): TaskRow {
  const isSummary = summaryIds.has(task.id);
  const rollup = allRollups.get(task.id);
  const hasConstraint = task.constraints.type !== 'none' && !!task.constraints.date;
  return {
    id: task.id,
    name: task.name,
    start: isSummary && rollup ? rollup.start : task.start,
    end: isSummary && rollup ? rollup.end : task.end,
    progress: isSummary && rollup ? rollup.progress : task.progress,
    isMilestone: task.isMilestone,
    color: task.color,
    depth,
    wbsNumber: wbs,
    isCritical: criticalIds.has(task.id),
    isSummary,
    constraint: hasConstraint
      ? { type: task.constraints.type, date: task.constraints.date! }
      : undefined,
    hasConstraintConflict: conflictIds.has(task.id),
  };
}

/**
 * Build the set of task ids that have at least one child. Derived from the
 * full task list so collapse state (which removes children from `visible`)
 * does not demote a summary task to a leaf for rendering purposes.
 */
function buildSummaryIds(tasks: ReadonlyArray<Task>): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.parentId) ids.add(t.parentId);
  }
  return ids;
}

/**
 * Compute pixel positions for every dependency arrow whose endpoints are both
 * currently visible. Returns arrows in scene-local pixel coords (with
 * scrollLeft/Top already subtracted).
 */
function computeArrows(
  file: GanttlyFile,
  opts: AssembleOptions,
  visible: ReturnType<typeof flattenVisible>,
  firstVisibleRow: number,
  criticalIds: ReadonlySet<string>,
  conflictIds: ReadonlySet<string>,
): ArrowSpec[] {
  const originDate = originDateFor(file, opts);
  const zoom = file.viewState.zoom;
  const out: ArrowSpec[] = [];

  const rowIndex = new Map<string, number>();
  visible.forEach((n, i) => rowIndex.set(n.task.id, i));

  for (const successor of file.tasks) {
    for (const dep of successor.dependencies) {
      const predecessor = file.tasks.find((t) => t.id === dep.targetId);
      if (!predecessor) continue;
      const fromIdx = rowIndex.get(predecessor.id);
      const toIdx = rowIndex.get(successor.id);
      if (fromIdx === undefined || toIdx === undefined) continue;

      const fromX = endpointX(
        predecessor,
        dep.type,
        'from',
        originDate,
        zoom,
        file.viewState.scrollLeft,
      );
      const toX = endpointX(successor, dep.type, 'to', originDate, zoom, file.viewState.scrollLeft);
      const fromY = HEADER_HEIGHT + (fromIdx - firstVisibleRow + 0.5) * ROW_HEIGHT;
      const toY = HEADER_HEIGHT + (toIdx - firstVisibleRow + 0.5) * ROW_HEIGHT;

      out.push({
        fromId: predecessor.id,
        toId: successor.id,
        type: dep.type,
        fromX,
        fromY,
        toX,
        toY,
        isCritical: criticalIds.has(successor.id) && criticalIds.has(predecessor.id),
        // G4: flag arrows INTO a successor whose constraint conflicts with deps.
        isConflict: conflictIds.has(successor.id),
      });
    }
  }
  return out;
}

/** Returns the X pixel (viewport-local) for the appropriate edge of a bar. */
function endpointX(
  task: Task,
  depType: 'FS' | 'SS' | 'FF' | 'SF',
  role: 'from' | 'to',
  originDate: string,
  zoom: GanttlyFile['viewState']['zoom'],
  scrollLeft: number,
): number {
  // For the FROM side: FS/FF use predecessor END; SS/SF use predecessor START.
  // For the TO side: FS/SS use successor START; FF/SF use successor END.
  const useEnd =
    (role === 'from' && (depType === 'FS' || depType === 'FF')) ||
    (role === 'to' && (depType === 'FF' || depType === 'SF'));
  const iso = useEnd ? task.end : task.start;
  const offsetDays = useEnd ? 1 : 0; // end is inclusive — pixel position of day AFTER end
  const px = dateToPixel(iso, originDate, zoom) + offsetDays * pixelsPerDay(zoom);
  return px - scrollLeft;
}

export function originDateFor(file: GanttlyFile, _opts?: AssembleOptions): string {
  // Anchor at the project start date if present, otherwise the earliest task.
  const fallback = file.project.startDate ?? '2026-01-05';
  if (file.tasks.length === 0) return fallback;
  const minStart = file.tasks.reduce(
    (min, t) => (t.start < min ? t.start : min),
    file.tasks[0]!.start,
  );
  return minStart < fallback ? minStart : fallback;
}

/**
 * The latest task end (or today, whichever is later) — used to size the
 * horizontal scroll extent so the ScrollShim reflects the real date range.
 * Exposed for the chart host (GanttCanvas) and the Today button.
 */
export function chartEndDate(file: GanttlyFile, today: string): string {
  if (file.tasks.length === 0) return today;
  const maxEnd = file.tasks.reduce((max, t) => (t.end > max ? t.end : max), file.tasks[0]!.end);
  return maxEnd > today ? maxEnd : today;
}

/** Filter holidays to those within `[today-365, today+365]`. */
function holidaysInRange(holidays: Holiday[], _opts: AssembleOptions): Holiday[] {
  return holidays;
}

/** Re-exported for tests. */
export const _dayDiff = dayDiff;

// ---------------------------------------------------------------------------
// Resource view scene assembly (P1 feature one)
// ---------------------------------------------------------------------------

import type { ResourceScene, ResourceRow, ResourceLoadBar } from '../render/types';
import { computeResourceLoad } from '@/lib/resourceLoad';
import { tasksByResource } from '@/lib/resourceTasks';

export interface AssembleResourceOptions {
  viewportWidth: number;
  viewportHeight: number;
  today: string;
  scrollTop: number;
  selectedResourceId: string | null;
  /** Expanded (drilled-down) resource ids — drives task-lane rows. */
  expandedResourceIds?: ReadonlySet<string>;
  /** Highlighted task lane (G19: independent of selectedTaskId). */
  selectedTaskIdInResource?: string | null;
}

/**
 * Build the renderable `ResourceScene` for the resource (load) view.
 *
 * Mirrors `assembleScene`'s contract (origin/scroll/holidays reuse the same
 * time axis). The flattened `rows` list interleaves resource rows with a
 * local task header and their expanded task lanes so the left list and right
 * canvas stay pixel-aligned:
 * each entry carries a global `yIndex` used for `yIndex * ROW_HEIGHT` layout.
 * Resource rows keep their per-day load bars; task lanes carry the task's
 * date span + the resource's load on it for the lane rectangle.
 */
export function assembleResourceScene(
  file: GanttlyFile,
  opts: AssembleResourceOptions,
): ResourceScene {
  const cal = resolveCalendar(getCalendar(file.calendar.id) ?? getCalendar('zh-CN'));
  const loadMap = computeResourceLoad(file.tasks, file.resources, cal);

  // Pre-compute which task ids have children once (used both for the
  // leaf-only filter in `tasksByResource` and WBS numbering via buildTree).
  const tree = buildTree(file.tasks);
  const nodeByTaskId = new Map<string, (typeof tree)[number]>();
  const indexTree = (nodes: ReadonlyArray<(typeof tree)[number]>): void => {
    for (const n of nodes) {
      nodeByTaskId.set(n.task.id, n);
      indexTree(n.children);
    }
  };
  indexTree(tree);
  const hasChildren = (id: string) => {
    const node = nodeByTaskId.get(id);
    return !!node && node.children.length > 0;
  };
  const tasksByRes = tasksByResource(file.tasks, hasChildren);

  const expanded = opts.expandedResourceIds ?? new Set<string>();
  const rows: ResourceRow[] = [];
  let yIndex = 0;

  for (const r of file.resources) {
    const perDay = loadMap.get(r.id) ?? new Map<string, number>();
    const bars: ResourceLoadBar[] = [];
    for (const [date, load] of perDay) {
      if (load > 0) bars.push({ resourceId: r.id, date, load });
    }
    const resourceTasks = tasksByRes.get(r.id) ?? [];
    rows.push({
      kind: 'resource',
      yIndex: yIndex++,
      id: r.id,
      name: r.name,
      role: r.role,
      capacity: r.capacity ?? 1,
      bars,
      expanded: expanded.has(r.id),
      taskCount: resourceTasks.length,
    });

    // Drill-down task lanes (only when expanded).
    if (expanded.has(r.id) && resourceTasks.length > 0) {
      rows.push({
        kind: 'task-header',
        yIndex: yIndex++,
        resourceId: r.id,
      });
      for (const t of resourceTasks) {
        const assignment = t.assignments.find((a) => a.resourceId === r.id);
        const node = nodeByTaskId.get(t.id);
        rows.push({
          kind: 'task',
          yIndex: yIndex++,
          taskId: t.id,
          resourceId: r.id,
          name: t.name,
          wbsNumber: node?.wbsNumber ?? '',
          start: t.start,
          end: t.end,
          duration: t.duration,
          progress: t.progress,
          isMilestone: t.isMilestone,
          load: assignment?.load ?? 0,
          capacity: r.capacity ?? 1,
        });
      }
    }
  }

  // Note: rows are passed in full (not pre-sliced) so the renderer's row
  // virtualization uses the correct global index for pixel positioning.
  // Resource counts are typically small (<100), so the cost of iterating all
  // rows to find the visible window is negligible.

  return {
    zoom: file.viewState.zoom,
    originDate: originDateFor(file),
    scrollLeft: file.viewState.scrollLeft,
    scrollTop: opts.scrollTop,
    viewportWidth: opts.viewportWidth,
    viewportHeight: opts.viewportHeight,
    today: opts.today,
    holidays: file.calendar.holidays,
    rows,
    selectedResourceId: opts.selectedResourceId,
    selectedTaskIdInResource: opts.selectedTaskIdInResource ?? null,
  };
}
