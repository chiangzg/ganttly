/**
 * Resource → tasks reverse lookup (resource-view drill-down).
 *
 * The data model links tasks to resources via `task.assignments[]` (many-to-
 * many), so listing the tasks mounted on a given resource requires walking
 * `file.tasks` and grouping by `resourceId`. This mirrors the same "leaf only"
 * rule used by `computeResourceLoad` (resourceLoad.ts): summary tasks never
 * carry real assignments (TaskDrawer forbids it), so they are excluded to stay
 * consistent with the load chart's accounting.
 */
import type { Task } from '@ganttly/schema';

/**
 * Group leaf tasks by the resources they are assigned to.
 *
 * @param tasks      All tasks in the project.
 * @param hasChildren Predicate returning true when a task id has child tasks
 *                    (i.e. it is a summary). Reuse the same child-detection as
 *                    the load calculator so "leaf" means the same thing here.
 * @returns Map<resourceId, Task[]>. Each list is sorted by `task.start` ascending
 *          (ties broken by name then id) so the drill-down reads top-to-bottom
 *          along the time axis, matching the load bars.
 */
export function tasksByResource(
  tasks: ReadonlyArray<Task>,
  hasChildren: (id: string) => boolean,
): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    if (hasChildren(t.id)) continue; // summary tasks excluded (G13 parity)
    if (!t.assignments || t.assignments.length === 0) continue;
    for (const a of t.assignments) {
      const list = map.get(a.resourceId);
      if (list) list.push(t);
      else map.set(a.resourceId, [t]);
    }
  }
  for (const list of map.values()) {
    list.sort(
      (a, b) =>
        a.start.localeCompare(b.start) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }
  return map;
}
