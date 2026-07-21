/**
 * Critical Path Method (CPM) — PRD §3.6.
 *
 * Algorithm:
 * 1. Build a DAG from dependencies (predecessor → successor).
 * 2. Forward pass: each task's earliest start = max(predecessors' earliest
 *    end + lag), earliest end = earliest start + duration.
 * 3. Backward pass: each task's latest end = min(successors' latest start -
 *    lag), latest start = latest end - duration.
 * 4. Total float = latest start - earliest start. Tasks with float 0 are
 *    critical.
 *
 * The critical PATH is the longest chain of critical tasks linked by
 * dependencies. A task can be critical without being on the longest chain
 * (rare); we surface all zero-float tasks as critical for the highlight.
 *
 * Calendar-aware: durations are in working days; the algorithm operates on
 * day counts, not absolute dates, to keep math simple. Callers convert back.
 *
 * Multi-root: the graph may have multiple disconnected components (subtrees
 * without external dependencies). Each is processed independently.
 */
import type { Task } from '@ganttly/schema';
import {
  isWorkingDay,
  resolveCalendar,
  addCalendarDays,
  type ResolvedCalendar,
} from '@/lib/calendar';
import type { Calendar } from '@ganttly/schema';

export interface CpmResult {
  /** Per-task earliest start date (ISO). */
  earliestStart: Map<string, string>;
  /** Per-task earliest end date (ISO, inclusive). */
  earliestEnd: Map<string, string>;
  /** Per-task latest start date (ISO). */
  latestStart: Map<string, string>;
  /** Per-task latest end date (ISO, inclusive). */
  latestEnd: Map<string, string>;
  /** Per-task total float in WORKING days. */
  totalFloat: Map<string, number>;
  /** Set of task ids on the critical path (float == 0). */
  criticalTaskIds: Set<string>;
  /** Total project duration in working days (longest path). */
  projectDurationDays: number;
}

/**
 * Run CPM. Tasks not in the input array but referenced by dependencies are
 * treated as missing — those dependencies are ignored.
 *
 * Implementation note: we use Kahn-style topological traversal for both
 * forward and backward passes. Cycle detection is implicit: if a cycle
 * exists, the forward pass will leave some nodes unprocessed (their earliest
 * start stays unset). We surface those as non-critical and proceed.
 */
export function computeCriticalPath(tasks: ReadonlyArray<Task>, calendar: Calendar): CpmResult {
  const cal = resolveCalendar(calendar);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ids = tasks.map((t) => t.id);

  // Adjacency: predecessorId -> [{ successorId, lag }]
  const successorsOf = new Map<string, Array<{ successorId: string; lag: number }>>();
  // In-degree: successorId -> count of predecessors
  const inDegree = new Map<string, number>();
  for (const id of ids) {
    successorsOf.set(id, []);
    inDegree.set(id, 0);
  }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!byId.has(dep.targetId)) continue;
      successorsOf.get(dep.targetId)!.push({ successorId: task.id, lag: dep.lag });
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  // ---- Forward pass (Kahn) ----
  const earliestStart = new Map<string, string>();
  const earliestEnd = new Map<string, string>();

  // Initialise roots (no predecessors) with their own start date.
  const queue: string[] = [];
  for (const id of ids) {
    if ((inDegree.get(id) ?? 0) === 0) {
      const task = byId.get(id)!;
      earliestStart.set(id, task.start);
      earliestEnd.set(id, endFromStart(task.start, task.duration, cal));
      queue.push(id);
    }
  }

  // Process in topological order, mutating in-degree.
  const inDegreeCopy = new Map(inDegree);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curEnd = earliestEnd.get(cur)!;
    for (const { successorId, lag } of successorsOf.get(cur) ?? []) {
      const successor = byId.get(successorId);
      if (!successor) continue;
      // Earliest start of successor = max(current earliestStart, predecessor.end + 1 + lag) working days
      const implied = addLag(curEnd, 1 + lag, cal);
      const current = earliestStart.get(successorId);
      if (!current || implied > current) {
        earliestStart.set(successorId, implied);
        earliestEnd.set(successorId, endFromStart(implied, successor.duration, cal));
      }
      const deg = (inDegreeCopy.get(successorId) ?? 0) - 1;
      inDegreeCopy.set(successorId, deg);
      if (deg === 0) queue.push(successorId);
    }
  }

  // Tasks that weren't reachable (cycle or disconnected missing refs) fall
  // back to using their own start.
  for (const id of ids) {
    if (!earliestStart.has(id)) {
      const task = byId.get(id)!;
      earliestStart.set(id, task.start);
      earliestEnd.set(id, endFromStart(task.start, task.duration, cal));
    }
  }

  // ---- Project duration: max earliestEnd ----
  let projectEnd = '';
  for (const id of ids) {
    const e = earliestEnd.get(id)!;
    if (projectEnd === '' || e > projectEnd) projectEnd = e;
  }
  // Duration in working days from earliest start to project end.
  let minStart = '';
  for (const id of ids) {
    const s = earliestStart.get(id)!;
    if (minStart === '' || s < minStart) minStart = s;
  }
  const projectDurationDays =
    projectEnd && minStart ? countWorkingDays(minStart, projectEnd, cal) : 0;

  // ---- Backward pass ----
  // Latest end initialised to projectEnd for "sink" tasks (no successors).
  const latestEnd = new Map<string, string>();
  const latestStart = new Map<string, string>();
  // Out-degree (successors).
  const outDegree = new Map<string, number>();
  for (const id of ids) outDegree.set(id, (successorsOf.get(id) ?? []).length);

  // predecessorsOf for backward walk.
  const predecessorsOf = new Map<string, string[]>();
  for (const id of ids) predecessorsOf.set(id, []);
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!byId.has(dep.targetId)) continue;
      predecessorsOf.get(task.id)!.push(dep.targetId);
    }
  }

  const backwardQueue: string[] = [];
  // If the project has no tasks (empty), projectEnd is empty; skip the
  // backward pass entirely and leave latest maps empty.
  if (projectEnd) {
    for (const id of ids) {
      if ((outDegree.get(id) ?? 0) === 0) {
        latestEnd.set(id, projectEnd);
        const task = byId.get(id)!;
        latestStart.set(id, startFromEnd(projectEnd, task.duration, cal));
        backwardQueue.push(id);
      }
    }
  }
  const outDegreeCopy = new Map(outDegree);
  while (backwardQueue.length > 0) {
    const cur = backwardQueue.shift()!;
    const curLatestStart = latestStart.get(cur)!;
    for (const predId of predecessorsOf.get(cur) ?? []) {
      // The predecessor's latest end is min(current latestEnd, successor.latestStart - lag - 1)
      const successor = byId.get(cur)!;
      const dep = successor.dependencies.find((d) => d.targetId === predId)!;
      const implied = addLag(curLatestStart, -(1 + dep.lag), cal);
      const current = latestEnd.get(predId);
      if (!current || implied < current) {
        latestEnd.set(predId, implied);
        const pred = byId.get(predId)!;
        latestStart.set(predId, startFromEnd(implied, pred.duration, cal));
      }
      const deg = (outDegreeCopy.get(predId) ?? 0) - 1;
      outDegreeCopy.set(predId, deg);
      if (deg === 0) backwardQueue.push(predId);
    }
  }
  // Fill any unprocessed (defensive — should match forward coverage).
  for (const id of ids) {
    if (!latestEnd.has(id)) {
      const task = byId.get(id)!;
      latestEnd.set(id, earliestEnd.get(id)!);
      latestStart.set(id, earliestStart.get(id)!);
      void task;
    }
  }

  // ---- Total float = latestStart - earliestStart (in working days) ----
  const totalFloat = new Map<string, number>();
  const criticalTaskIds = new Set<string>();
  for (const id of ids) {
    const es = earliestStart.get(id);
    const ls = latestStart.get(id);
    if (!es || !ls) {
      // No backward pass ran (empty project) — treat as non-critical.
      totalFloat.set(id, 0);
      continue;
    }
    // countWorkingDays is inclusive of both endpoints; subtract 1 to get
    // the gap (so float=0 when ls===es).
    const float = Math.max(0, countWorkingDays(es, ls, cal) - 1);
    totalFloat.set(id, float);
    if (float === 0) criticalTaskIds.add(id);
  }

  return {
    earliestStart,
    earliestEnd,
    latestStart,
    latestEnd,
    totalFloat,
    criticalTaskIds,
    projectDurationDays,
  };
}

// ---- Calendar helpers ----

function endFromStart(startISO: string, duration: number, cal: ResolvedCalendar): string {
  if (duration <= 0) return startISO;
  let cursor = startISO;
  let counted = 1;
  // Skip the start if it's non-working (advance to first working day).
  if (!isWorkingDay(cursor, cal)) {
    cursor = nextWorking(cursor, cal);
  }
  while (counted < duration) {
    cursor = addCalendarDays(cursor, 1);
    if (isWorkingDay(cursor, cal)) counted++;
  }
  return cursor;
}

function startFromEnd(endISO: string, duration: number, cal: ResolvedCalendar): string {
  if (duration <= 0) return endISO;
  let cursor = endISO;
  let counted = 1;
  while (counted < duration) {
    cursor = addCalendarDays(cursor, -1);
    if (isWorkingDay(cursor, cal)) counted++;
  }
  return cursor;
}

/** Add `n` working days to `iso`. Negative n walks backward. */
function addLag(iso: string, n: number, cal: ResolvedCalendar): string {
  if (n === 0) return iso;
  let cursor = iso;
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    cursor = addCalendarDays(cursor, step);
    if (isWorkingDay(cursor, cal)) remaining--;
  }
  return cursor;
}

function nextWorking(iso: string, cal: ResolvedCalendar): string {
  let cursor = iso;
  for (let i = 0; i < 366; i++) {
    if (isWorkingDay(cursor, cal)) return cursor;
    cursor = addCalendarDays(cursor, 1);
  }
  return iso;
}

/** Count working days in `[startISO, endISO]` inclusive. */
function countWorkingDays(startISO: string, endISO: string, cal: ResolvedCalendar): number {
  if (endISO < startISO) return 0;
  let cursor = startISO;
  let n = 0;
  for (let i = 0; i < 10_000 && cursor <= endISO; i++) {
    if (isWorkingDay(cursor, cal)) n++;
    cursor = addCalendarDays(cursor, 1);
  }
  return n;
}
