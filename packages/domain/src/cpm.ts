/**
 * Critical Path Method (CPM) — PRD §3.6.
 *
 * Algorithm:
 * 1. Build a DAG from dependencies (predecessor → successor). All four
 *    precedence types (FS/SS/FF/SF) participate, with the SAME working-day
 *    semantics as the scheduling engine in `schedule.ts` (computeImpliedStart
 *    / computeImpliedEnd) — the scheduler keeps the drawn plan satisfying
 *    these links, so the CPM must read them identically:
 *      FS: succ.start ≥ pred.end   + 1 + lag      (working days)
 *      SS: succ.start ≥ pred.start + lag
 *      FF: succ.end   ≥ pred.end   + lag
 *      SF: succ.end   ≥ pred.start + lag
 *    FF/SF constrain the successor's END; with fixed duration they convert to
 *    a start floor via back-calculation.
 * 2. Forward pass (as-scheduled): each task's earliest start = max(its own
 *    drawn start, every predecessor's implied start). The drawn start seeds
 *    the pass so a manually delayed task keeps driving the project end (MS
 *    Project behaviour); a drawn-EARLY task is still pulled forward by the
 *    network — violations are never rewarded. Task constraints (G18) apply on
 *    top: SNET floor, MSO/MFO hard anchors.
 * 3. Backward pass mirrors the forward semantics per edge type: latest end =
 *    min over successors' implied latest end.
 * 4. Total float = latest start − earliest start (working days, clamped at
 *    0). Tasks with float 0 are critical.
 *
 * The critical PATH is the longest chain of critical tasks linked by
 * dependencies. A task can be critical without being on the longest chain
 * (rare); we surface all zero-float tasks as critical for the highlight.
 *
 * Calendar-aware: durations are in working days; all arithmetic walks the
 * project calendar. NOTE: only LEAF tasks should be fed into this function —
 * summary rollup duration is summed effort, not a time span (see web
 * lib/criticalPath.ts, which is the single entry point for rendering).
 *
 * Multi-root: the graph may have multiple disconnected components (subtrees
 * without external dependencies). Each is processed independently.
 */
import type { Task, DependencyType } from '@ganttly/schema';
import { isWorkingDay, resolveCalendar, addCalendarDays, type ResolvedCalendar } from './calendar';
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

  // Adjacency: predecessorId -> [{ successorId, type, lag }]
  const successorsOf = new Map<
    string,
    Array<{ successorId: string; type: DependencyType; lag: number }>
  >();
  // In-degree: successorId -> count of predecessors
  const inDegree = new Map<string, number>();
  for (const id of ids) {
    successorsOf.set(id, []);
    inDegree.set(id, 0);
  }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!byId.has(dep.targetId)) continue;
      successorsOf.get(dep.targetId)!.push({ successorId: task.id, type: dep.type, lag: dep.lag });
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  // ---- Forward pass (Kahn, as-scheduled) ----
  const earliestStart = new Map<string, string>();
  const earliestEnd = new Map<string, string>();

  // As-scheduled seed: EVERY task starts from its own drawn start (constraint
  // applied), then dependency edges may only pull it LATER. A manually
  // delayed task therefore keeps driving the project end; a drawn-early
  // violation is pulled forward by the network instead.
  for (const id of ids) {
    const task = byId.get(id)!;
    const { start, end } = applyForwardConstraint(task, task.start, cal);
    earliestStart.set(id, start);
    earliestEnd.set(id, end);
  }

  // Process in topological order, mutating in-degree.
  const inDegreeCopy = new Map(inDegree);
  const queue: string[] = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curStart = earliestStart.get(cur)!;
    const curEnd = earliestEnd.get(cur)!;
    for (const { successorId, type, lag } of successorsOf.get(cur) ?? []) {
      const successor = byId.get(successorId);
      if (!successor) continue;
      const implied = impliedSuccessorStart(type, lag, curStart, curEnd, successor.duration, cal);
      const current = earliestStart.get(successorId)!;
      if (implied > current) {
        // G18: re-apply the successor's constraint against the new implied start.
        const { start, end } = applyForwardConstraint(successor, implied, cal);
        earliestStart.set(successorId, start);
        earliestEnd.set(successorId, end);
      }
      const deg = (inDegreeCopy.get(successorId) ?? 0) - 1;
      inDegreeCopy.set(successorId, deg);
      if (deg === 0) queue.push(successorId);
    }
  }

  // Tasks that weren't reachable (cycle) fall back to their constraint-applied
  // seed — already set above, nothing to do.

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
        const task = byId.get(id)!;
        // G18: apply backward constraint (FNLT ceiling / MFO anchor).
        const end = applyBackwardConstraint(task, projectEnd, cal);
        latestEnd.set(id, end);
        latestStart.set(id, startFromEnd(end, task.duration, cal));
        backwardQueue.push(id);
      }
    }
  }
  const outDegreeCopy = new Map(outDegree);
  while (backwardQueue.length > 0) {
    const cur = backwardQueue.shift()!;
    const curLatestStart = latestStart.get(cur)!;
    const curLatestEnd = latestEnd.get(cur)!;
    for (const predId of predecessorsOf.get(cur) ?? []) {
      const successor = byId.get(cur)!;
      const dep = successor.dependencies.find((d) => d.targetId === predId)!;
      const pred = byId.get(predId)!;
      // Mirror of the forward semantics per edge type, clamped at the project
      // end — with SS/SF edges a predecessor's end may otherwise be capped
      // only by a short successor and drift past the project horizon.
      const rawImplied = impliedPredecessorEnd(
        dep.type,
        dep.lag,
        curLatestStart,
        curLatestEnd,
        pred.duration,
        cal,
      );
      const implied = projectEnd && rawImplied > projectEnd ? projectEnd : rawImplied;
      const current = latestEnd.get(predId);
      if (!current || implied < current) {
        // G18: re-apply the predecessor's backward constraint against the new implied end.
        const end = applyBackwardConstraint(pred, implied, cal);
        latestEnd.set(predId, end);
        latestStart.set(predId, startFromEnd(end, pred.duration, cal));
      }
      const deg = (outDegreeCopy.get(predId) ?? 0) - 1;
      outDegreeCopy.set(predId, deg);
      if (deg === 0) backwardQueue.push(predId);
    }
  }
  // Fill any unprocessed (defensive — should match forward coverage).
  for (const id of ids) {
    if (!latestEnd.has(id)) {
      latestEnd.set(id, earliestEnd.get(id)!);
      latestStart.set(id, earliestStart.get(id)!);
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

/**
 * Forward-pass edge semantics: the earliest START a dependency type allows for
 * a successor of `duration` working days, given the predecessor's earliest
 * start/end. Mirrors `computeImpliedStart`/`computeImpliedEnd` in schedule.ts.
 */
function impliedSuccessorStart(
  type: DependencyType,
  lag: number,
  predEarliestStart: string,
  predEarliestEnd: string,
  successorDuration: number,
  cal: ResolvedCalendar,
): string {
  switch (type) {
    case 'FS':
      return addLag(predEarliestEnd, 1 + lag, cal);
    case 'SS':
      return addLag(predEarliestStart, lag, cal);
    case 'FF':
      // succ.end ≥ pred.end + lag → back-calculate the start.
      return startFromEnd(addLag(predEarliestEnd, lag, cal), successorDuration, cal);
    case 'SF':
      // succ.end ≥ pred.start + lag → back-calculate the start.
      return startFromEnd(addLag(predEarliestStart, lag, cal), successorDuration, cal);
  }
}

/**
 * Backward-pass mirror: the latest END a dependency type allows for a
 * predecessor of `duration` working days, given the successor's latest
 * start/end.
 */
function impliedPredecessorEnd(
  type: DependencyType,
  lag: number,
  successorLatestStart: string,
  successorLatestEnd: string,
  predecessorDuration: number,
  cal: ResolvedCalendar,
): string {
  switch (type) {
    case 'FS':
      return addLag(successorLatestStart, -(1 + lag), cal);
    case 'SS':
      // pred.LS ≤ succ.LS − lag → a START cap, so the END cap walks FORWARD
      // by the predecessor's duration.
      return endFromStart(addLag(successorLatestStart, -lag, cal), predecessorDuration, cal);
    case 'FF':
      return addLag(successorLatestEnd, -lag, cal);
    case 'SF':
      // succ.end ≥ pred.start + lag → pred.LS ≤ succ.LE − lag → END cap forward.
      return endFromStart(addLag(successorLatestEnd, -lag, cal), predecessorDuration, cal);
  }
}

/**
 * Apply a task's constraint to its forward-pass earliest start (G18).
 *  - SNET (soft floor): earliestStart = max(depImplied, constraintDate)
 *  - MSO  (hard anchor): earliestStart = constraintDate (override)
 *  - MFO  (hard anchor): earliestStart = constraintDate - duration (back-calc)
 *  - FNLT / none: no forward effect (FNLT only affects latestEnd)
 *
 * `depImplied` is the dependency-implied earliest start (or the task's own
 * start for roots). Returns the adjusted {start, end}.
 */
function applyForwardConstraint(
  task: Task,
  depImplied: string,
  cal: ResolvedCalendar,
): { start: string; end: string } {
  const c = task.constraints;
  if (!c || c.type === 'none' || !c.date) {
    return { start: depImplied, end: endFromStart(depImplied, task.duration, cal) };
  }
  const anchor = isWorkingDay(c.date, cal) ? c.date : nextWorking(c.date, cal);
  switch (c.type) {
    case 'startNoEarlierThan': {
      const start = depImplied >= anchor ? depImplied : anchor;
      return { start, end: endFromStart(start, task.duration, cal) };
    }
    case 'mustStartOn': {
      // Hard anchor — override unconditionally.
      return { start: anchor, end: endFromStart(anchor, task.duration, cal) };
    }
    case 'mustFinishOn': {
      // Hard anchor on end — back-calculate start.
      return { start: startFromEnd(anchor, task.duration, cal), end: anchor };
    }
    case 'finishNoLaterThan':
    default:
      return { start: depImplied, end: endFromStart(depImplied, task.duration, cal) };
  }
}

/**
 * Apply a task's constraint to its backward-pass latest end (G18).
 *  - FNLT (soft ceiling): latestEnd = min(depImplied, constraintDate)
 *  - MFO  (hard anchor): latestEnd = constraintDate (override)
 *  - SNET/MSO/none: no backward effect.
 */
function applyBackwardConstraint(task: Task, depImplied: string, cal: ResolvedCalendar): string {
  const c = task.constraints;
  if (!c || c.type === 'none' || !c.date) return depImplied;
  const anchor = isWorkingDay(c.date, cal) ? c.date : nextWorking(c.date, cal);
  switch (c.type) {
    case 'finishNoLaterThan':
      // Soft ceiling — take the earlier of dep-implied and constraint.
      return depImplied <= anchor ? depImplied : anchor;
    case 'mustFinishOn':
      // Hard anchor — override unconditionally.
      return anchor;
    case 'startNoEarlierThan':
    case 'mustStartOn':
    default:
      return depImplied;
  }
}

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
