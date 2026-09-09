/**
 * Project-level critical-path entry point (single shared computation).
 *
 * Summaries never enter the CPM graph: a summary's rollup `duration` is the
 * SUM of its children's work durations (effort), not its time span, so feeding
 * it to the CPM as one giant task pushes the projected project end months past
 * reality and every true chain picks up phantom float (diagnosed 2026-09-09 on
 * real data: 业财 span 46wd vs summed duration 146wd → project end 2027-02-25
 * instead of 2026-11-23).
 *
 * Instead:
 *   1. CPM runs over LEAF tasks only (milestones included — they are leaves).
 *   2. A summary row derives criticality at render time: red when ANY leaf
 *      descendant is critical, bubbled up through the parentId chain here so
 *      every consumer sees one flat set.
 *
 * Dependency-level consequences (intended):
 *   - Dependencies pointing AT a summary are invisible to the CPM (the summary
 *     is not a node) — summary-level links are discouraged in the UI
 *     (TaskDrawer) but existing data degrades losslessly.
 *
 * Both assembleScene (canvas highlighting) and buildFilterPredicate
 * ('criticalPath' quick filter) must call THIS function — a previous split
 * where the filter fed raw `file.tasks` to the CPM produced results that
 * diverged from the canvas.
 */
import type { Calendar, Task } from '@ganttly/schema';
import { computeCriticalPath } from './cpm';

export interface ProjectCriticalPath {
  /**
   * Zero-float LEAF task ids — the raw CPM output. Use this when the consumer
   * explicitly means "tasks on the critical chain" (e.g. the row filter).
   */
  leafCriticalIds: Set<string>;
  /**
   * `leafCriticalIds` PLUS every ancestor summary with ≥1 critical leaf
   * descendant. Canvas row highlighting uses this so a red chain shows a red
   * rollup bar without the summary itself distorting the graph.
   */
  criticalTaskIds: Set<string>;
}

export function computeProjectCriticalPath(
  tasks: ReadonlyArray<Task>,
  calendar: Calendar,
): ProjectCriticalPath {
  // Summary = any task that is a parent. Same derivation as assembly's
  // buildSummaryIds (full task list, collapse-state independent).
  const summaryIds = new Set<string>();
  for (const t of tasks) {
    if (t.parentId) summaryIds.add(t.parentId);
  }

  const leaves = tasks.filter((t) => !summaryIds.has(t.id));
  const cpm = computeCriticalPath(leaves, calendar);

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const criticalTaskIds = new Set(cpm.criticalTaskIds);
  for (const id of cpm.criticalTaskIds) {
    let parent = byId.get(id)?.parentId;
    while (parent && !criticalTaskIds.has(parent)) {
      criticalTaskIds.add(parent);
      parent = byId.get(parent)?.parentId;
    }
  }

  return { leafCriticalIds: cpm.criticalTaskIds, criticalTaskIds };
}
