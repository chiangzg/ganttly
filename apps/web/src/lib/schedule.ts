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
import type { Calendar, Dependency, Task } from '@ganttly/schema';
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
