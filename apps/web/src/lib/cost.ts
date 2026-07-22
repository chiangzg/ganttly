/**
 * Person-day (effort) computation (P1 feature two).
 *
 * Grilling Q7 scoped cost down to person-days only — no monetary dimension.
 * Formula: `personDays = Σ (load/100 × capacity × duration)` over a task's
 * assignments, where `duration` is the task's working-day span.
 *
 * Summary tasks short-circuit (G13): they return the rolled-up sum of their
 * children's person-days and ignore their own `assignments`, preventing
 * double-counting when a `.gan` import or hand-edited JSON assigned resources
 * to a summary.
 */
import type { Task, Resource } from '@ganttly/schema';

/**
 * Person-days for a single leaf task: Σ(assignment load% × resource capacity ×
 * task duration). Returns 0 for a task with no assignments.
 */
export function computeTaskPersonDays(task: Task, resources: ReadonlyArray<Resource>): number {
  if (task.assignments.length === 0) return 0;
  const resourceMap = new Map(resources.map((r) => [r.id, r]));
  let total = 0;
  for (const a of task.assignments) {
    const resource = resourceMap.get(a.resourceId);
    const capacity = resource?.capacity ?? 1;
    total += (a.load / 100) * capacity * task.duration;
  }
  // Round to 2 decimals to avoid float drift in display.
  return Math.round(total * 100) / 100;
}

/**
 * Person-days contributed by ONE resource on a task: the matching
 * assignment's `load/100 × capacity × duration`, or 0 if the resource is not
 * assigned. Used by the resource view's drill-down, where each task lane is
 * scoped to a single resource (so the task-wide `computeTaskPersonDays` would
 * over-count by including other assignees).
 */
export function computeAssignmentPersonDays(
  task: Task,
  resourceId: string,
  resources: ReadonlyArray<Resource>,
): number {
  const assignment = task.assignments.find((a) => a.resourceId === resourceId);
  if (!assignment) return 0;
  const resource = resources.find((r) => r.id === resourceId);
  const capacity = resource?.capacity ?? 1;
  const pd = (assignment.load / 100) * capacity * task.duration;
  return Math.round(pd * 100) / 100;
}

/**
 * Total person-days across all tasks in a project (sum of leaf-task effort).
 * Summary tasks contribute via their children, so this sums every leaf once.
 */
export function totalPersonDays(
  tasks: ReadonlyArray<Task>,
  resources: ReadonlyArray<Resource>,
): number {
  const summaryIds = new Set<string>();
  for (const t of tasks) {
    if (t.parentId) summaryIds.add(t.parentId);
  }
  let total = 0;
  for (const t of tasks) {
    // Skip summary tasks — their effort rolls up from children (G13).
    if (summaryIds.has(t.id)) continue;
    total += computeTaskPersonDays(t, resources);
  }
  return Math.round(total * 100) / 100;
}
