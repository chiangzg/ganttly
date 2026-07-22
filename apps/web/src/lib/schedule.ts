/**
 * Dependency scheduling (PRD §3.3, M2.6).
 *
 * Implements the four standard precedence types (FS, SS, FF, SF) and the
 * working-day calendar (PRD §3.5). Auto-rescheduling propagates changes
 * downstream when a predecessor moves.
 *
 * Pure functions: no side effects. The caller decides whether to write the
 * computed dates back via a Command.
 */
import type { Calendar, Dependency, Task, TaskConstraints } from '@ganttly/schema';
import {
  resolveCalendar,
  endDateFromDuration,
  nextWorkingDay,
  addCalendarDays,
  isWorkingDay,
  type ResolvedCalendar,
} from '@/lib/calendar';

export interface ScheduleResult {
  /** New start date for the task, or undefined if unchanged. */
  start?: string;
  /** New end date for the task, or undefined if unchanged. */
  end?: string;
  /** Reason the result was produced (debug UI / status). */
  reason: string;
}

/**
 * Compute the implied start of a successor task given a predecessor and a
 * dependency. Returns the successor's earliest allowed start date.
 *
 *   FS (Finish-Start): successor.start ≥ predecessor.end + lag
 *   SS (Start-Start):  successor.start ≥ predecessor.start + lag
 *   FF (Finish-Finish): affects successor.end (use computeImpliedEnd)
 *   SF (Start-Finish):  affects successor.end (use computeImpliedEnd)
 */
export function computeImpliedStart(
  predecessor: Task,
  dep: Dependency,
  cal: ResolvedCalendar,
): string {
  // Lag is in WORKING days. Convert to a date offset based on a working-day walk.
  const addWorkingDaysFrom = (startISO: string, days: number): string => {
    if (days === 0) return startISO;
    let cursor = startISO;
    const step = days > 0 ? 1 : -1;
    let remaining = Math.abs(days);
    while (remaining > 0) {
      cursor = addCalendarDays(cursor, step);
      if (isWorkingDay(cursor, cal)) remaining--;
    }
    return cursor;
  };

  switch (dep.type) {
    case 'FS': {
      // Predecessor's end is the LAST working day. The successor can start the
      // NEXT working day, plus lag working days.
      const base = addCalendarDays(predecessor.end, 1); // day after predecessor end
      const anchored = nextWorkingDay(base, cal);
      return addWorkingDaysFrom(anchored, dep.lag);
    }
    case 'SS': {
      const anchored = nextWorkingDay(predecessor.start, cal);
      return addWorkingDaysFrom(anchored, dep.lag);
    }
    case 'FF':
    case 'SF':
      // These constrain the END; the start is implied via duration. Caller
      // should use computeImpliedEnd and then back-calculate.
      return predecessor.start;
  }
}

/** Returns the implied END date for FF/SF dependencies. */
export function computeImpliedEnd(
  predecessor: Task,
  dep: Dependency,
  cal: ResolvedCalendar,
): string {
  const addWorkingDaysFrom = (startISO: string, days: number): string => {
    if (days === 0) return startISO;
    let cursor = startISO;
    const step = days > 0 ? 1 : -1;
    let remaining = Math.abs(days);
    while (remaining > 0) {
      cursor = addCalendarDays(cursor, step);
      if (isWorkingDay(cursor, cal)) remaining--;
    }
    return cursor;
  };

  switch (dep.type) {
    case 'FF': {
      // Successor.end ≥ predecessor.end + lag (working days)
      const anchored = predecessor.end;
      return addWorkingDaysFrom(anchored, dep.lag);
    }
    case 'SF': {
      // Successor.end ≥ predecessor.start + lag
      return addWorkingDaysFrom(predecessor.start, dep.lag);
    }
    case 'FS':
    case 'SS':
      return predecessor.end;
  }
}

/** Returns true if `dep` would be satisfied given the current predecessor and successor. */
export function isDependencySatisfied(
  predecessor: Task,
  successor: Task,
  dep: Dependency,
  cal: ResolvedCalendar,
): boolean {
  switch (dep.type) {
    case 'FS': {
      const implied = computeImpliedStart(predecessor, dep, cal);
      return successor.start >= implied;
    }
    case 'SS': {
      const implied = computeImpliedStart(predecessor, dep, cal);
      return successor.start >= implied;
    }
    case 'FF': {
      const implied = computeImpliedEnd(predecessor, dep, cal);
      return successor.end >= implied;
    }
    case 'SF': {
      const implied = computeImpliedEnd(predecessor, dep, cal);
      return successor.end >= implied;
    }
  }
}

/**
 * Auto-reschedule the successor to satisfy `dep`. Returns the new start/end
 * (unchanged if already satisfied).
 */
export function satisfyDependency(
  predecessor: Task,
  successor: Task,
  dep: Dependency,
  cal: ResolvedCalendar,
): ScheduleResult {
  if (dep.type === 'FS' || dep.type === 'SS') {
    const implied = computeImpliedStart(predecessor, dep, cal);
    if (successor.start >= implied) {
      return { reason: 'already-satisfied' };
    }
    // Move start forward; preserve duration.
    const duration = Math.max(1, successor.duration);
    const end = endDateFromDuration(implied, duration, cal);
    return { start: implied, end, reason: 'rescheduled-FS/SS' };
  }
  // FF / SF
  const impliedEnd = computeImpliedEnd(predecessor, dep, cal);
  if (successor.end >= impliedEnd) {
    return { reason: 'already-satisfied' };
  }
  // Move end forward; preserve duration by also moving start.
  const duration = Math.max(1, successor.duration);
  // Walk backward `duration - 1` working days from impliedEnd.
  let cursor = impliedEnd;
  let remaining = duration - 1;
  while (remaining > 0) {
    cursor = addCalendarDays(cursor, -1);
    if (isWorkingDay(cursor, cal)) remaining--;
  }
  return { start: cursor, end: impliedEnd, reason: 'rescheduled-FF/SF' };
}

/**
 * Detect whether adding `newDep` (predecessor → successor, i.e. the successor
 * would gain a new dependency on the predecessor) would create a cycle.
 *
 * A cycle forms iff there's already a directed path from `successorId` to
 * `predecessorId` (i.e. the successor is already a transitive predecessor of
 * the proposed predecessor). Adding the reverse edge closes the loop.
 */
export function wouldCreateCycle(
  tasks: ReadonlyArray<Task>,
  newDep: { successorId: string; predecessorId: string },
): boolean {
  const { successorId, predecessorId } = newDep;
  if (successorId === predecessorId) return true; // self-loop

  // Build successor edges: task.id -> ids of tasks that depend on it.
  const successorsOf = new Map<string, string[]>();
  for (const t of tasks) {
    for (const d of t.dependencies) {
      const list = successorsOf.get(d.targetId) ?? [];
      list.push(t.id);
      successorsOf.set(d.targetId, list);
    }
  }

  // Starting from successorId, can we reach predecessorId by following
  // successor edges? If yes → adding the reverse edge creates a cycle.
  const stack = [successorId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === predecessorId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of successorsOf.get(cur) ?? []) {
      stack.push(next);
    }
  }
  return false;
}

/** Convenience: resolve the calendar once and reuse for many calls. */
export function makeScheduler(calendar: Calendar) {
  const cal = resolveCalendar(calendar);
  return {
    cal,
    computeImpliedStart: (p: Task, d: Dependency) => computeImpliedStart(p, d, cal),
    computeImpliedEnd: (p: Task, d: Dependency) => computeImpliedEnd(p, d, cal),
    satisfyDependency: (p: Task, s: Task, d: Dependency) => satisfyDependency(p, s, d, cal),
    isDependencySatisfied: (p: Task, s: Task, d: Dependency) => isDependencySatisfied(p, s, d, cal),
  };
}

// ---------------------------------------------------------------------------
// Cascade engine (P1 feature three — E1.1, G17)
// ---------------------------------------------------------------------------

/** A date patch for one task, produced by cascade propagation. */
export interface CascadePatch {
  id: string;
  patch: { start?: string; end?: string };
}

// ---------------------------------------------------------------------------
// Constraint scheduling (P1 feature three — C1.2, G12/G18)
// ---------------------------------------------------------------------------

/**
 * Snap a constraint date to the next working day if it falls on a non-working
 * day (G12). MSO/MFO are hard anchors but the schedule is working-day-aware;
 * anchoring on a weekend would make `start = end - duration` cross weekends
 * and produce confusing dates. Snapping forward is the conservative choice
 * for "no earlier than" / "must finish by" semantics.
 *
 * Returns the (possibly snapped) date and whether snapping occurred.
 */
export function snapConstraintDate(
  dateISO: string,
  cal: ResolvedCalendar,
): { date: string; snapped: boolean; original: string } {
  if (isWorkingDay(dateISO, cal)) {
    return { date: dateISO, snapped: false, original: dateISO };
  }
  return { date: nextWorkingDay(dateISO, cal), snapped: true, original: dateISO };
}

/**
 * Apply a constraint to a task whose dependencies are already satisfied,
 * returning the resulting start/end. Implements G18:
 *  - SNET (soft): earliestStart = max(depImpliedStart, constraintDate)
 *  - MSO  (hard anchor): start = constraintDate (unconditional override)
 *  - MFO  (hard anchor): end = constraintDate → start = end - duration + 1
 *  - FNLT (soft): affects end only — end = min(depImpliedEnd, constraintDate)
 *
 * `depImpliedStart` is the start after dependency cascade (or the task's own
 * start if it has no dependencies). The constraint layer runs AFTER the
 * dependency layer, per the cascade algorithm.
 */
export function satisfyConstraint(
  task: Task,
  constraint: TaskConstraints,
  cal: ResolvedCalendar,
  depImpliedStart?: string,
): { start: string; end: string; conflict: boolean } {
  const start = depImpliedStart ?? task.start;
  const duration = Math.max(1, task.duration);

  if (constraint.type === 'none' || !constraint.date) {
    return { start, end: task.end, conflict: false };
  }

  const { date: anchor } = snapConstraintDate(constraint.date, cal);

  switch (constraint.type) {
    case 'startNoEarlierThan': {
      // Soft: take the later of dep-implied and constraint.
      const newStart = start >= anchor ? start : anchor;
      const newEnd = endDateFromDuration(newStart, duration, cal);
      return { start: newStart, end: newEnd, conflict: false };
    }
    case 'mustStartOn': {
      // Hard anchor: start == anchor, unconditional. Conflict if this violates
      // a dependency (anchor < depImpliedStart).
      const newEnd = endDateFromDuration(anchor, duration, cal);
      const conflict = depImpliedStart !== undefined && anchor < depImpliedStart;
      return { start: anchor, end: newEnd, conflict };
    }
    case 'mustFinishOn': {
      // Hard anchor: end == anchor. Back-calculate start.
      const newEnd = anchor;
      // Walk backward duration-1 working days from anchor for the start.
      let cursor = anchor;
      let remaining = duration - 1;
      while (remaining > 0) {
        cursor = addCalendarDays(cursor, -1);
        if (isWorkingDay(cursor, cal)) remaining--;
      }
      const conflict = depImpliedStart !== undefined && cursor < depImpliedStart;
      return { start: cursor, end: newEnd, conflict };
    }
    case 'finishNoLaterThan': {
      // Soft: end = min(depImpliedEnd, anchor). Only tightens.
      const depEnd = task.end;
      const newEnd = depEnd <= anchor ? depEnd : anchor;
      if (newEnd === task.end) {
        return { start, end: task.end, conflict: false };
      }
      // Recalculate start from the new (earlier) end.
      let cursor = newEnd;
      let remaining = duration - 1;
      while (remaining > 0) {
        cursor = addCalendarDays(cursor, -1);
        if (isWorkingDay(cursor, cal)) remaining--;
      }
      return { start: cursor, end: newEnd, conflict: false };
    }
    default:
      return { start, end: task.end, conflict: false };
  }
}

/**
 * Detect constraint-vs-dependency conflicts across all tasks. A conflict exists
 * when a hard anchor (MSO/MFO) forces a start earlier than a dependency
 * implies. Returns the list of conflicting task ids (for arrow highlighting).
 */
export function checkConstraintConflicts(
  tasks: ReadonlyArray<Task>,
  cal: ResolvedCalendar,
): Set<string> {
  const conflicts = new Set<string>();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  for (const task of tasks) {
    if (task.constraints.type === 'none' || !task.constraints.date) continue;
    if (task.dependencies.length === 0) continue;

    // Compute the dependency-implied earliest start (max over all deps).
    let depImpliedStart = task.start;
    for (const dep of task.dependencies) {
      const pred = taskById.get(dep.targetId);
      if (!pred) continue;
      const implied = computeImpliedStart(pred, dep, cal);
      if (implied > depImpliedStart) depImpliedStart = implied;
    }

    const result = satisfyConstraint(task, task.constraints, cal, depImpliedStart);
    if (result.conflict) {
      conflicts.add(task.id);
    }
  }
  return conflicts;
}

/**
 * Count tasks whose start violates at least one dependency (successor.start <
 * predecessor-implied start). Used by the load-time check (G14) to decide
 * whether to prompt the user for auto-rescheduling.
 */
export function countDependencyViolations(
  tasks: ReadonlyArray<Task>,
  cal: ResolvedCalendar,
): number {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  let count = 0;
  for (const task of tasks) {
    if (task.dependencies.length === 0) continue;
    let violated = false;
    for (const dep of task.dependencies) {
      const pred = taskById.get(dep.targetId);
      if (!pred) continue;
      if (!isDependencySatisfied(pred, task, dep, cal)) {
        violated = true;
        break;
      }
    }
    if (violated) count++;
  }
  return count;
}

/**
 * Starting from `changedTaskId`, propagate date changes downstream through the
 * dependency DAG so every successor satisfies its dependencies.
 *
 * Algorithm (G17): Kahn topological sort over the successor subgraph reachable
 * from `changedTaskId`. Each successor is rescheduled once via
 * {@link satisfyDependency} against ALL its predecessors (not just the changed
 * one — a task with two predecessors must satisfy both). Topological order
 * guarantees a node is processed only after all its predecessors are final, so
 * one pass suffices and termination is deterministic (O(V+E)).
 *
 * Cycle guard: if the dependency graph contains a cycle (shouldn't happen —
 * `wouldCreateCycle` guards `addDependencyCommand` — but imported/hand-edited
 * data may), the Kahn queue drains before all nodes are processed. We detect
 * that and bail out (returning only the patches computed so far) rather than
 * looping forever.
 *
 * Pure: returns patches; the caller applies them via a Command.
 */
export function cascadeSchedule(
  tasks: ReadonlyArray<Task>,
  changedTaskId: string,
  cal: ResolvedCalendar,
): CascadePatch[] {
  const taskById = new Map<string, Task>();
  for (const t of tasks) taskById.set(t.id, t);

  // Build successor edges: predecessorId -> [successorIds that depend on it].
  const successorsOf = new Map<string, string[]>();
  // In-degree (count of UNRESOLVED predecessors) for each successor.
  const inDegree = new Map<string, number>();
  for (const t of tasks) {
    if (t.dependencies.length > 0) {
      inDegree.set(t.id, t.dependencies.length);
      for (const d of t.dependencies) {
        const list = successorsOf.get(d.targetId) ?? [];
        list.push(t.id);
        successorsOf.set(d.targetId, list);
      }
    }
  }

  // Working copy of task dates we mutate as we propagate. We need fresh values
  // because a successor may be rescheduled by an earlier predecessor before a
  // later predecessor is checked.
  const current = new Map<string, Task>();
  for (const t of tasks) current.set(t.id, { ...t });

  // Compute the set of tasks reachable downstream from changedTaskId. These are
  // the only tasks that MAY need rescheduling. Everything else is final (its
  // current dates are unchanged and authoritative) — this is what lets a task
  // with a mix of changed and unchanged predecessors resolve correctly.
  const downstream = new Set<string>();
  {
    const stack = [changedTaskId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const succ of successorsOf.get(cur) ?? []) {
        if (!downstream.has(succ)) {
          downstream.add(succ);
          stack.push(succ);
        }
      }
    }
  }

  // `final` = tasks whose dates are authoritative (either unchanged, or already
  // rescheduled). Everything NOT in `downstream` is unchanged → final. The
  // changed task itself is final (caller already applied its new dates).
  const patches: CascadePatch[] = [];
  const final = new Set<string>([changedTaskId]);
  for (const t of tasks) {
    if (!downstream.has(t.id)) final.add(t.id);
  }

  const queue: string[] = [];

  // A successor is processable when ALL its predecessors are final.
  const tryEnqueue = (id: string): void => {
    if (final.has(id)) return;
    const deps = taskById.get(id)?.dependencies ?? [];
    if (deps.every((d) => final.has(d.targetId))) queue.push(id);
  };

  for (const succ of successorsOf.get(changedTaskId) ?? []) {
    tryEnqueue(succ);
  }

  // Kahn-style processing: dequeue a successor, reschedule it against all its
  // (now-final) predecessors, mark it final, enqueue its successors.
  let guard = 0;
  while (queue.length > 0 && guard < tasks.length * 2) {
    guard++;
    const succId = queue.shift()!;
    if (final.has(succId)) continue;
    const succ = current.get(succId);
    if (!succ) continue;

    // Reschedule against EVERY predecessor (the task must satisfy all deps).
    let rescheduled = false;
    let start = succ.start;
    let end = succ.end;
    for (const dep of succ.dependencies) {
      const pred = current.get(dep.targetId);
      if (!pred) continue;
      const result = satisfyDependency(pred, { ...succ, start, end }, dep, cal);
      if (result.start || result.end) {
        rescheduled = true;
        if (result.start) start = result.start;
        if (result.end) end = result.end;
      }
    }

    final.add(succId);
    current.set(succId, { ...succ, start, end });

    if (rescheduled && (start !== succ.start || end !== succ.end)) {
      patches.push({ id: succId, patch: { start, end } });
    }

    for (const next of successorsOf.get(succId) ?? []) {
      tryEnqueue(next);
    }
  }

  return patches;
}
