/**
 * Pure core of the priority-matrix view (priority-matrix spec §2, §4).
 *
 * Everything here is store- and DOM-free so the bucketing, sorting and
 * date-hint rules can be unit-tested directly. `PriorityMatrix` only renders
 * what these functions produce.
 */
import { isTaskPriority, TASK_PRIORITIES } from '@ganttly/schema';
import type { GanttlyFile, Task, TaskPriority } from '@ganttly/schema';
import { buildTree, flattenAll } from '@/engine/scene';
import { dayDiff } from '@/engine/layout';
import { durationBetween, isWorkingDay } from '@/lib/calendar';
import type { ResolvedCalendar } from '@/lib/calendar';
import { matchesSearch } from '@/lib/taskFilter';

/** Where a card can live: the not-yet-triaged tray, or one of the four quadrants. */
export type MatrixBucket = 'tray' | TaskPriority;

export type MatrixSortMode = 'default' | 'end' | 'start' | 'progress' | 'wbs';

export const MATRIX_SORT_MODES: readonly MatrixSortMode[] = [
  'default',
  'end',
  'start',
  'progress',
  'wbs',
];

export const DEFAULT_MATRIX_SORT: Readonly<Record<TaskPriority, MatrixSortMode>> = {
  1: 'default',
  2: 'default',
  3: 'default',
  4: 'default',
};

/** A task is "due soon" when it ends within this many working days (spec §2.2). */
export const DUE_SOON_WORKING_DAYS = 3;

export interface MatrixFilters {
  /** Shared with the task tree's search box: matches name or WBS number. */
  searchQuery: string;
  /** `'all'` | `'none'` (unassigned) | a resource id. */
  assignee: string;
  showDone: boolean;
  /** Each quadrant remembers its own sort. The tray is always in WBS order. */
  sort: Readonly<Record<TaskPriority, MatrixSortMode>>;
}

/** A leaf task plus the WBS number it is addressed by. */
export interface MatrixCard {
  task: Task;
  wbsNumber: string;
}

export interface MatrixModel {
  tray: MatrixCard[];
  quadrants: Record<TaskPriority, MatrixCard[]>;
  /** Every leaf task (milestones included, summaries excluded) before filters. */
  leafTotal: number;
  isFiltered: boolean;
}

export const isDone = (task: Task): boolean => task.progress >= 100;

/** Same rule as the task tree's "延期" filter. */
export const isOverdue = (task: Task, today: string): boolean => !isDone(task) && task.end < today;

export type DueHint =
  /** `days` = calendar days since the end date. */
  | { kind: 'overdue'; days: number }
  /** `workingDays` = working days after today (0 = due today). */
  | { kind: 'dueSoon'; workingDays: number }
  | { kind: 'done' }
  | { kind: 'none' };

/**
 * Date hint for a card (spec §2.2). Only a hint — it never changes which
 * quadrant a task belongs to.
 */
export function dueHint(task: Task, today: string, cal: ResolvedCalendar): DueHint {
  if (isDone(task)) return { kind: 'done' };
  if (task.end < today) return { kind: 'overdue', days: dayDiff(task.end, today) };
  // Working days strictly AFTER today, up to and including the end date.
  // `durationBetween` counts both endpoints, so take today back out when it is
  // a working day: "due today" is 0, "due tomorrow" is 1.
  const workingDays = durationBetween(today, task.end, cal) - (isWorkingDay(today, cal) ? 1 : 0);
  return workingDays <= DUE_SOON_WORKING_DAYS ? { kind: 'dueSoon', workingDays } : { kind: 'none' };
}

/** Numeric WBS order: `1.10` sorts after `1.2` (a plain string compare gets it wrong). */
export function compareWbs(a: string, b: string): number {
  const pa = a ? a.split('.').map(Number) : [];
  const pb = b ? b.split('.').map(Number) : [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const cmpText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Order inside one bucket. Completed tasks always sink to the end (spec §4.3). */
export function compareMatrixCards(
  a: MatrixCard,
  b: MatrixCard,
  mode: MatrixSortMode,
  today: string,
): number {
  const doneDiff = Number(isDone(a.task)) - Number(isDone(b.task));
  if (doneDiff !== 0) return doneDiff;
  let c = 0;
  switch (mode) {
    case 'default': {
      // Overdue first (rank 0), then by end date.
      const overdueA = isOverdue(a.task, today) ? 0 : 1;
      const overdueB = isOverdue(b.task, today) ? 0 : 1;
      c = overdueA - overdueB || cmpText(a.task.end, b.task.end);
      break;
    }
    case 'end':
      c = cmpText(a.task.end, b.task.end);
      break;
    case 'start':
      c = cmpText(a.task.start, b.task.start);
      break;
    case 'progress':
      c = a.task.progress - b.task.progress;
      break;
    case 'wbs':
      c = 0;
      break;
  }
  return c || compareWbs(a.wbsNumber, b.wbsNumber);
}

function matchesAssignee(task: Task, assignee: string): boolean {
  if (assignee === 'all') return true;
  if (assignee === 'none') return task.assignments.length === 0;
  return task.assignments.some((a) => a.resourceId === assignee);
}

/**
 * Split the visible leaf tasks into the tray and the four quadrants (spec §2.3,
 * §4.3). Summaries never enter the matrix; a task only counts as P1–P4 when its
 * `priority` is one of the four valid values.
 */
export function bucketMatrixTasks(
  file: GanttlyFile,
  filters: MatrixFilters,
  today: string,
): MatrixModel {
  const nodes = flattenAll(buildTree(file.tasks));
  const nodeById = new Map(nodes.map((n) => [n.task.id, n]));

  const tray: MatrixCard[] = [];
  const quadrants: Record<TaskPriority, MatrixCard[]> = { 1: [], 2: [], 3: [], 4: [] };
  let leafTotal = 0;

  for (const task of file.tasks) {
    const node = nodeById.get(task.id);
    // A node with children is a summary; its dates/progress are rollups and it
    // is not something the user triages.
    if (!node || node.children.length > 0) continue;
    leafTotal += 1;
    if (isDone(task) && !filters.showDone) continue;
    if (!matchesAssignee(task, filters.assignee)) continue;
    if (!matchesSearch(task, node, filters.searchQuery)) continue;

    const card: MatrixCard = { task, wbsNumber: node.wbsNumber };
    // The guard matters for data that bypasses `normalizeFile` (e.g. a file
    // injected straight into the store): an out-of-range value reads as
    // "not triaged" instead of indexing a bucket that does not exist.
    if (isTaskPriority(task.priority)) quadrants[task.priority].push(card);
    else tray.push(card);
  }

  tray.sort((a, b) => compareMatrixCards(a, b, 'wbs', today));
  for (const p of TASK_PRIORITIES) {
    quadrants[p].sort((a, b) => compareMatrixCards(a, b, filters.sort[p], today));
  }

  return {
    tray,
    quadrants,
    leafTotal,
    isFiltered: filters.searchQuery.trim() !== '' || filters.assignee !== 'all',
  };
}

/** Cards in reading order (tray first) — the sequence Shift-click ranges over. */
export function matrixVisibleIds(model: MatrixModel): string[] {
  return [...model.tray, ...TASK_PRIORITIES.flatMap((p) => model.quadrants[p])].map(
    (card) => card.task.id,
  );
}

/**
 * What a drop on `target` means for `task` (spec §4.5). `changed` is false when
 * the task is already there — the caller must then dispatch nothing, since the
 * store records an undo entry even for a no-op command.
 */
export function resolvePriorityDrop(
  target: MatrixBucket,
  task: Task,
): { priority: TaskPriority | undefined; changed: boolean } {
  const priority: TaskPriority | undefined = target === 'tray' ? undefined : target;
  return { priority, changed: task.priority !== priority };
}
