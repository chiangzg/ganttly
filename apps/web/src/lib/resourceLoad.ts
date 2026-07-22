/**
 * Resource load computation (P1 feature one).
 *
 * Aggregates per-resource daily load from `TaskAssignment`s. For each task, the
 * assignment's `load` (0-100, percent allocation) is added to every working day
 * in `[task.start, task.end]`. A resource assigned to two overlapping tasks
 * therefore accumulates load additively — e.g. load=30 on task X + load=70 on
 * task Y over the same days yields 100% (no overload) on those days.
 *
 * Output shape: `Map<resourceId, Map<dateISO, totalLoad>>` where `totalLoad`
 * may exceed 100 (overload). Consumers (the load-chart renderer) color bars
 * green ≤100, red >100.
 *
 * Performance: O(tasks × assignments × workingDays). For 100 tasks × 5
 * assignments × 30 days ≈ 15k iterations — cheap enough to recompute during
 * scene assembly rather than every render frame.
 */
import type { Task, Resource } from '@ganttly/schema';
import type { ResolvedCalendar } from './calendar';
import { iterateWorkingDays } from './calendar';

export type ResourceLoadMap = Map<string, Map<string, number>>;

/**
 * Compute the daily load for every resource, summed across all assignments.
 *
 * `resources` is accepted (not just tasks) so the result map can be pre-seeded
 * with an entry for every known resource — even those with no assignments —
 * which simplifies downstream rendering (no `?. ?? 0` guards).
 */
export function computeResourceLoad(
  tasks: Task[],
  resources: Resource[],
  cal: ResolvedCalendar,
): ResourceLoadMap {
  // Seed with one inner map per resource so renderers can iterate uniformly.
  const loadMap: ResourceLoadMap = new Map();
  for (const r of resources) {
    loadMap.set(r.id, new Map());
  }

  for (const task of tasks) {
    // Summary tasks roll up their children; their own assignments are ignored
    // (G13: double-count guard). The caller should avoid assigning to summary
    // tasks, but this keeps the math safe regardless.
    if (task.assignments.length === 0) continue;
    const days = Array.from(iterateWorkingDays(task.start, task.end, cal));
    for (const assignment of task.assignments) {
      const perDay = loadMap.get(assignment.resourceId);
      if (!perDay) continue; // assignment references an unknown resource
      for (const date of days) {
        perDay.set(date, (perDay.get(date) ?? 0) + assignment.load);
      }
    }
  }

  return loadMap;
}

/**
 * Returns the load for a resource on a specific date, or 0 if none.
 */
export function loadOn(loadMap: ResourceLoadMap, resourceId: string, dateISO: string): number {
  return loadMap.get(resourceId)?.get(dateISO) ?? 0;
}

/**
 * Returns the peak (max) daily load for a resource across all dates, or 0 if
 * the resource has no load. Useful for quick overload checks without iterating
 * the whole chart.
 */
export function peakLoad(loadMap: ResourceLoadMap, resourceId: string): number {
  const perDay = loadMap.get(resourceId);
  if (!perDay || perDay.size === 0) return 0;
  let peak = 0;
  for (const v of perDay.values()) {
    if (v > peak) peak = v;
  }
  return peak;
}
