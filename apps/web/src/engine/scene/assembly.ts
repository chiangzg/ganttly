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
import { HEADER_HEIGHT, ROW_HEIGHT, dateToPixel, dayDiff } from '../layout';
import { buildTree, flattenVisible } from './tree';
import { computeCriticalPath } from '@/lib/cpm';

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

  // Compute the critical path once per assembly. Cheap (<1ms for hundreds of
  // tasks) and gives every row the `isCritical` flag for highlighting.
  const cpm = opts.criticalTaskIds
    ? null
    : computeCriticalPath(
        file.tasks.map((t) => ({
          ...t,
          // For summary tasks (those with children), use the rolled-up dates.
          // computeCriticalPath treats each task independently; we replace
          // summary duration/end with min(child.start)/max(child.end) below.
        })),
        file.calendar,
      );
  const criticalIds = opts.criticalTaskIds ?? cpm?.criticalTaskIds ?? new Set<string>();

  // Virtualise rows: drop rows above/below the visible scroll area.
  const firstVisibleRow = Math.max(0, Math.floor(file.viewState.scrollTop / ROW_HEIGHT) - 5);
  const lastVisibleRow = Math.min(
    visible.length,
    Math.ceil((file.viewState.scrollTop + opts.viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT) + 5,
  );
  const visibleSlice = visible.slice(firstVisibleRow, lastVisibleRow);

  const rows: TaskRow[] = visibleSlice.map((node) =>
    toTaskRow(node.task, node.depth, node.wbsNumber, criticalIds, visible),
  );

  const arrows = computeArrows(file, opts, visible, firstVisibleRow, criticalIds);

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
  visible: ReturnType<typeof flattenVisible>,
): TaskRow {
  return {
    id: task.id,
    name: task.name,
    start: task.start,
    end: task.end,
    progress: task.progress,
    isMilestone: task.isMilestone,
    color: task.color,
    depth,
    wbsNumber: wbs,
    isCritical: criticalIds.has(task.id),
    isSummary: hasChildren(task.id, visible),
  };
}

function hasChildren(id: string, visible: ReturnType<typeof flattenVisible>): boolean {
  return visible.some((n) => n.task.parentId === id);
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
      const fromY =
        HEADER_HEIGHT + (fromIdx - firstVisibleRow + 0.5) * ROW_HEIGHT - file.viewState.scrollTop;
      const toY =
        HEADER_HEIGHT + (toIdx - firstVisibleRow + 0.5) * ROW_HEIGHT - file.viewState.scrollTop;

      out.push({
        fromId: predecessor.id,
        toId: successor.id,
        type: dep.type,
        fromX,
        fromY,
        toX,
        toY,
        isCritical: criticalIds.has(successor.id) && criticalIds.has(predecessor.id),
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
  const px = dateToPixel(iso, originDate, zoom) + offsetDays * pxPerDay(zoom);
  return px - scrollLeft;
}

function pxPerDay(zoom: GanttlyFile['viewState']['zoom']): number {
  // Mirror layout.pixelsPerDay without an import cycle.
  const COLUMN_WIDTH = { day: 32, week: 140, month: 120, year: 80 } as const;
  const DAYS_PER_COLUMN = { day: 1, week: 7, month: 30, year: 30 } as const;
  return COLUMN_WIDTH[zoom] / DAYS_PER_COLUMN[zoom];
}

function originDateFor(file: GanttlyFile, _opts: AssembleOptions): string {
  // Anchor at the project start date if present, otherwise the earliest task.
  const fallback = file.project.startDate ?? '2026-01-05';
  if (file.tasks.length === 0) return fallback;
  const minStart = file.tasks.reduce(
    (min, t) => (t.start < min ? t.start : min),
    file.tasks[0]!.start,
  );
  return minStart < fallback ? minStart : fallback;
}

/** Filter holidays to those within `[today-365, today+365]`. */
function holidaysInRange(holidays: Holiday[], _opts: AssembleOptions): Holiday[] {
  return holidays;
}

/** Re-exported for tests. */
export const _dayDiff = dayDiff;
