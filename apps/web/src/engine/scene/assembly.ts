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
import type { GanttlyFile, Holiday, Task, Baseline, BaselineTask, Resource } from '@ganttly/schema';
import type { Scene, TaskRow, ArrowSpec } from '../render/types';
import { MILESTONE_RADIUS } from '../render/geometry';
import type { TaskBaselineVariance } from '@/lib/baseline';
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  dateToPixel,
  dayDiff,
  milestoneCenterX,
  pixelsPerDay,
} from '../layout';
import { buildTree, flattenVisible } from './tree';
import { computeCriticalPath } from '@/lib/cpm';
import { computeAllRollups } from '@/lib/summary';
import { checkConstraintConflicts } from '@/lib/schedule';
import { resolveCalendar, effectiveTaskDays } from '@/lib/calendar';
import { compareTaskToBaseline, buildEffectiveValues } from '@/lib/baseline';
import { resolveAssignees, computeAssigneeSummary } from '@/lib/assigneeSummary';
import { computeFilteredRows, isAnyFilterActive, type TaskFilter } from '@/lib/taskFilter';

export interface AssembleOptions {
  viewportWidth: number;
  viewportHeight: number;
  today: string;
  /** Set of task ids that are on the critical path (M3). */
  criticalTaskIds?: ReadonlySet<string>;
  /**
   * Active baseline for comparison (baseline-comparison spec §6.4). When
   * provided, each TaskRow carries its baseline snapshot + variance. Pass
   * `null`/`undefined` to disable comparison entirely.
   */
  activeBaseline?: Baseline | null;
  /**
   * Task-view search/filter (plan §4.4). When a query or non-'none' filter is
   * active, the scene rows mirror the task table: matched rows (plus their
   * ancestor context) are shown, collapsed ancestors force-expanded. Both
   * default to "inactive" so callers that don't pass them get the original
   * flattenVisible path.
   */
  searchQuery?: string;
  taskFilter?: TaskFilter;
  /**
   * Multi-select set (plan §4.6). Each id gets a selected outline on the
   * canvas; the anchor (`file.viewState.selectedTaskId`) additionally gets the
   * focus ring. Defaults to empty (no multi-selection) for callers that don't
   * pass it. Kept in opts (not read from a store) so the engine stays store-free.
   */
  selectedTaskIds?: ReadonlySet<string>;
}

export function assembleScene(file: GanttlyFile, opts: AssembleOptions): Scene {
  const tree = buildTree(file.tasks);
  // When a search/filter is active (plan §4.4), the scene must mirror the task
  // table: matched rows + ancestor context, with collapsed ancestors
  // force-expanded. Otherwise use the plain flattenVisible path so behaviour is
  // identical to pre-§4.4 (zero regression).
  const query = opts.searchQuery ?? '';
  const filter = opts.taskFilter ?? 'none';
  const visible = isAnyFilterActive(query, filter)
    ? computeFilteredRows(file, query, filter).rows
    : flattenVisible(tree, new Set(file.viewState.collapsedTaskIds));

  // Resolve the project's persisted calendar once for constraints and effort.
  const cal = resolveCalendar(file.calendar);

  // Pre-compute rollup values for all summary tasks. Used for both CPM input
  // (so critical-path sees a summary's true aggregated start/duration) and for
  // canvas row rendering (especially important during drag mid-states where
  // the underlying Task data may be momentarily stale).
  const allRollups = computeAllRollups(file.tasks, file.resources, cal);

  // Pre-build a resource lookup ONCE (plan §3.3) so per-row assignee
  // resolution is O(1) — never a `file.resources.find()` inside the row loop.
  const resourceById = new Map<string, Resource>(file.resources.map((r) => [r.id, r]));

  // Successor counts: how many other tasks depend on each task (plan §3.2
  // Tooltip). A task's own `dependencies` are its predecessors; a successor is
  // any task whose dependency `targetId` points at it. Built once, O(D).
  const successorCount = new Map<string, number>();
  for (const t of file.tasks) {
    for (const dep of t.dependencies) {
      successorCount.set(dep.targetId, (successorCount.get(dep.targetId) ?? 0) + 1);
    }
  }

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
  const conflictIds = checkConstraintConflicts(file.tasks, cal);

  // Baseline comparison prep (spec §6.4). Build the snapshot map ONCE (O(n))
  // and look up by id inside toTaskRow — never `baseline.tasks.find()` per row.
  // Effective current values (summary rollup applied) are shared between the
  // variance calc and the row so both see the same dates.
  const activeBaseline = opts.activeBaseline ?? null;
  const hasActiveBaseline = activeBaseline !== null;
  const baselineById = hasActiveBaseline
    ? new Map<string, BaselineTask>(activeBaseline.tasks.map((bt) => [bt.id, bt]))
    : null;
  // Reuse the rollups already computed above. Recomputing them here would add
  // a second full tree traversal to every scroll-driven scene assembly.
  const effectiveValues = hasActiveBaseline ? buildEffectiveValues(file, cal, allRollups) : null;

  // Virtualise rows: drop rows above/below the visible scroll area.
  const firstVisibleRow = Math.max(0, Math.floor(file.viewState.scrollTop / ROW_HEIGHT) - 5);
  const lastVisibleRow = Math.min(
    visible.length,
    Math.ceil((file.viewState.scrollTop + opts.viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT) + 5,
  );
  const visibleSlice = visible.slice(firstVisibleRow, lastVisibleRow);

  const rows: TaskRow[] = visibleSlice.map((node, i) =>
    toTaskRow(
      node.task,
      node.depth,
      node.wbsNumber,
      criticalIds,
      summaryIds,
      allRollups,
      conflictIds,
      firstVisibleRow + i, // global row index — drives pixel Y, mirrors ResourceRow.yIndex
      baselineById,
      effectiveValues,
      cal,
      resourceById,
      successorCount,
    ),
  );

  const arrows = computeArrows(file, opts, visible, criticalIds, conflictIds);

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
    totalRows: visible.length,
    arrows,
    showCriticalPath: file.viewState.showCriticalPath,
    hasActiveBaseline,
    selectedTaskId: file.viewState.selectedTaskId,
    selectedTaskIds: opts.selectedTaskIds ?? new Set<string>(),
  };
}

function toTaskRow(
  task: Task,
  depth: number,
  wbs: string,
  criticalIds: ReadonlySet<string>,
  summaryIds: ReadonlySet<string>,
  allRollups: Map<string, { start: string; end: string; duration: number; progress: number }>,
  conflictIds: ReadonlySet<string>,
  yIndex: number,
  baselineById: Map<string, BaselineTask> | null,
  effectiveValues: Map<string, { id: string; start: string; end: string; duration: number }> | null,
  cal: ReturnType<typeof resolveCalendar>,
  resourceById: ReadonlyMap<string, Resource>,
  successorCount: ReadonlyMap<string, number>,
): TaskRow {
  const isSummary = summaryIds.has(task.id);
  const rollup = allRollups.get(task.id);
  const hasConstraint = task.constraints.type !== 'none' && !!task.constraints.date;
  // Assignee resolution (plan §3.3) — O(assignments) with the pre-built map.
  // Summary tasks keep a name-only label, so we only compute assignees for
  // leaf tasks (the spec's `name · owner` applies to leaves).
  const assignees = isSummary ? [] : resolveAssignees(task.assignments, resourceById);
  const row: TaskRow = {
    id: task.id,
    name: task.name,
    start: isSummary && rollup ? rollup.start : task.start,
    end: isSummary && rollup ? rollup.end : task.end,
    // Summary duration comes from the rollup (working-day span); leaves keep
    // their own task.duration. Milestones are always 0.
    duration: task.isMilestone ? 0 : isSummary && rollup ? rollup.duration : task.duration,
    progress: isSummary && rollup ? rollup.progress : task.progress,
    isMilestone: task.isMilestone,
    color: task.color,
    depth,
    wbsNumber: wbs,
    isCritical: criticalIds.has(task.id),
    isSummary,
    yIndex,
    constraint: hasConstraint
      ? { type: task.constraints.type, date: task.constraints.date! }
      : undefined,
    hasConstraintConflict: conflictIds.has(task.id),
    assignees,
    assigneeSummary: isSummary ? undefined : computeAssigneeSummary(assignees),
    predecessorCount: task.dependencies.length,
    successorCount: successorCount.get(task.id) ?? 0,
  };

  // Baseline fields: only attach when a baseline is active. Summary tasks
  // compare their live rollup (already set on `row`) against the captured
  // snapshot; leaves compare their own fields. Added tasks get variance only.
  if (baselineById && effectiveValues) {
    const bt = baselineById.get(task.id);
    if (bt) row.baseline = bt;
    const eff = effectiveValues.get(task.id);
    if (eff) {
      const variance: TaskBaselineVariance = compareTaskToBaseline(eff, bt, cal);
      row.baselineVariance = variance;
    }
  }

  return row;
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
  criticalIds: ReadonlySet<string>,
  conflictIds: ReadonlySet<string>,
): ArrowSpec[] {
  const originDate = originDateFor(file, opts);
  const zoom = file.viewState.zoom;
  const out: ArrowSpec[] = [];

  const rowIndex = new Map<string, number>();
  visible.forEach((n, i) => rowIndex.set(n.task.id, i));

  const outgoing = new Map<string, Array<{ successorId: string; depIndex: number }>>();
  for (const successor of file.tasks) {
    successor.dependencies.forEach((dep, depIndex) => {
      const list = outgoing.get(dep.targetId) ?? [];
      list.push({ successorId: successor.id, depIndex });
      outgoing.set(dep.targetId, list);
    });
  }
  for (const list of outgoing.values()) {
    list.sort(
      (a, b) =>
        (rowIndex.get(a.successorId) ?? Number.MAX_SAFE_INTEGER) -
        (rowIndex.get(b.successorId) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  const incomingSlots = new Map<string, Map<number, number>>();
  for (const successor of file.tasks) {
    const ordered = successor.dependencies
      .map((dep, depIndex) => ({
        depIndex,
        row: rowIndex.get(dep.targetId) ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.row - b.row || a.depIndex - b.depIndex);
    incomingSlots.set(successor.id, new Map(ordered.map((entry, slot) => [entry.depIndex, slot])));
  }

  for (const successor of file.tasks) {
    for (const [depIndex, dep] of successor.dependencies.entries()) {
      const predecessor = file.tasks.find((t) => t.id === dep.targetId);
      if (!predecessor) continue;
      const fromIdx = rowIndex.get(predecessor.id);
      const toIdx = rowIndex.get(successor.id);
      if (fromIdx === undefined || toIdx === undefined) continue;

      const fromBaseX = endpointX(
        predecessor,
        dep.type,
        'from',
        originDate,
        zoom,
        file.viewState.scrollLeft,
      );
      const toBaseX = endpointX(
        successor,
        dep.type,
        'to',
        originDate,
        zoom,
        file.viewState.scrollLeft,
      );
      // Y in viewport pixels: global row index → chart px, minus scrollTop.
      // Matches bars.ts (`HEADER_HEIGHT + row.yIndex*ROW_HEIGHT - scrollTop`)
      // so arrow endpoints land exactly on their bar centres, aligned with the
      // left TaskTable during sub-row scroll.
      const fromBaseY = HEADER_HEIGHT + (fromIdx + 0.5) * ROW_HEIGHT - file.viewState.scrollTop;
      const toBaseY = HEADER_HEIGHT + (toIdx + 0.5) * ROW_HEIGHT - file.viewState.scrollTop;
      const outgoingPorts = outgoing.get(predecessor.id) ?? [];
      const outgoingIndex = outgoingPorts.findIndex(
        (entry) => entry.successorId === successor.id && entry.depIndex === depIndex,
      );
      const incomingIndex = incomingSlots.get(successor.id)?.get(depIndex) ?? depIndex;
      const fromOffset = portOffset(outgoingIndex, outgoingPorts.length);
      const toOffset = portOffset(incomingIndex, successor.dependencies.length);
      const fromSide = endpointSide(dep.type, 'from');
      const toSide = endpointSide(dep.type, 'to');
      const fromX = predecessor.isMilestone
        ? fromBaseX - fromSide * Math.abs(fromOffset)
        : fromBaseX;
      const toX = successor.isMilestone ? toBaseX - toSide * Math.abs(toOffset) : toBaseX;
      const fromY = fromBaseY + fromOffset;
      const toY = toBaseY + toOffset;

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

function portOffset(index: number, count: number): number {
  if (count <= 1 || index < 0) return 0;
  const spacing = Math.min(6, 14 / (count - 1));
  return (index - (count - 1) / 2) * spacing;
}

function endpointSide(depType: 'FS' | 'SS' | 'FF' | 'SF', role: 'from' | 'to'): -1 | 1 {
  if (role === 'from') return depType === 'SS' || depType === 'SF' ? -1 : 1;
  return depType === 'FF' || depType === 'SF' ? 1 : -1;
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
  // A milestone is rendered as a diamond centred on its day's END line (right
  // boundary), not as a one-day bar. Connect to the diamond edge so arrows do
  // not terminate under the marker when several dependencies converge on it.
  if (task.isMilestone) {
    const center = milestoneCenterX(task.start, originDate, zoom);
    const side = endpointSide(depType, role);
    return center + side * MILESTONE_RADIUS - scrollLeft;
  }
  const iso = useEnd ? task.end : task.start;
  const offsetDays = useEnd ? 1 : 0; // end is inclusive — pixel position of day AFTER end
  const px = dateToPixel(iso, originDate, zoom) + offsetDays * pixelsPerDay(zoom);
  return px - scrollLeft;
}

export function originDateFor(
  file: GanttlyFile,
  opts?: AssembleOptions | { activeBaseline?: Baseline | null },
): string {
  // Anchor at the project start date if present, otherwise the earliest task.
  const fallback = file.project.startDate ?? '2026-01-05';
  let minStart = fallback;
  if (file.tasks.length > 0) {
    minStart = file.tasks.reduce((min, t) => (t.start < min ? t.start : min), file.tasks[0]!.start);
    if (fallback < minStart) minStart = fallback;
  }
  // Baseline-comparison spec §6.5: only the ACTIVE baseline's earliest start
  // extends the origin (so its reference bar isn't clipped on the left).
  // Inactive baselines are deliberately ignored — historical snapshots must
  // not permanently widen the scroll range.
  const activeBaseline = opts?.activeBaseline ?? null;
  if (activeBaseline && activeBaseline.tasks.length > 0) {
    const blMin = activeBaseline.tasks.reduce(
      (min, bt) => (bt.start < min ? bt.start : min),
      activeBaseline.tasks[0]!.start,
    );
    if (blMin < minStart) minStart = blMin;
  }
  return minStart;
}

/**
 * The latest task end (or today, whichever is later) — used to size the
 * horizontal scroll extent so the ScrollShim reflects the real date range.
 * Exposed for the chart host (GanttCanvas) and the Today button.
 *
 * Baseline-comparison spec §6.5: when a baseline is active, its latest end
 * also extends the range so reference bars aren't clipped on the right.
 */
export function chartEndDate(
  file: GanttlyFile,
  today: string,
  activeBaseline?: Baseline | null,
): string {
  let maxEnd = today;
  if (file.tasks.length > 0) {
    const taskMax = file.tasks.reduce((max, t) => (t.end > max ? t.end : max), file.tasks[0]!.end);
    if (taskMax > maxEnd) maxEnd = taskMax;
  }
  if (activeBaseline && activeBaseline.tasks.length > 0) {
    const blMax = activeBaseline.tasks.reduce(
      (max, bt) => (bt.end > max ? bt.end : max),
      activeBaseline.tasks[0]!.end,
    );
    if (blMax > maxEnd) maxEnd = blMax;
  }
  return maxEnd;
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
  const cal = resolveCalendar(file.calendar);
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

  // Plan §3.5 / §6.2: build a per-resource, per-date contributing-task index
  // ONCE here (O(tasks × assignments × effortDays), same as computeResourceLoad)
  // so the hover tooltip can render the contribution list without an O(tasks)
  // scan on every pointer move. Map<resourceId, Map<dateISO, contributions[]>>.
  // Only leaf tasks (assignments exist, not summaries) contribute — mirrors the
  // load calculator's accounting so the tooltip's numbers match the bars.
  const contributionsByResource = new Map<
    string,
    Map<string, Array<{ taskId: string; name: string; load: number }>>
  >();
  for (const task of file.tasks) {
    if (hasChildren(task.id)) continue; // summaries never contribute (G13 parity with computeResourceLoad)
    if (task.assignments.length === 0) continue;
    const days = effectiveTaskDays(task, cal);
    for (const assignment of task.assignments) {
      let byDate = contributionsByResource.get(assignment.resourceId);
      if (!byDate) {
        byDate = new Map();
        contributionsByResource.set(assignment.resourceId, byDate);
      }
      for (const date of days) {
        let list = byDate.get(date);
        if (!list) {
          list = [];
          byDate.set(date, list);
        }
        list.push({ taskId: task.id, name: task.name, load: assignment.load });
      }
    }
  }

  // O(1) resource lookup for the hover/click tooltip (plan §3.5).
  const resourceById = new Map<
    string,
    { id: string; name: string; role?: string; capacity: number }
  >();
  for (const r of file.resources) {
    resourceById.set(r.id, { id: r.id, name: r.name, role: r.role, capacity: r.capacity ?? 1 });
  }

  const expanded = opts.expandedResourceIds ?? new Set<string>();
  const rows: ResourceRow[] = [];
  let yIndex = 0;

  for (const r of file.resources) {
    const perDay = loadMap.get(r.id) ?? new Map<string, number>();
    const contribByDate = contributionsByResource.get(r.id);
    const bars: ResourceLoadBar[] = [];
    for (const [date, load] of perDay) {
      if (load > 0) {
        bars.push({
          resourceId: r.id,
          date,
          load,
          // Attach the precomputed contributing tasks (plan §3.5). Empty list is
          // fine — the tooltip treats it as "no contributing tasks".
          contributions: contribByDate?.get(date) ?? [],
        });
      }
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
    resourceById,
  };
}
