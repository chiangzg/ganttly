/**
 * Deletion impact helpers (editor-interaction-optimization-plan §2.4).
 *
 * Compute the human-readable impact of deleting a task or resource, used by
 * the confirmation dialog. Pure functions — no store access, no side effects.
 */

import type { Task } from '@ganttly/schema';

export interface TaskDeleteImpact {
  /** Number of descendant subtasks that will also be deleted. */
  childCount: number;
  /** Number of dependency edges pointing to this task (deleted on cascade). */
  dependencyCount: number;
  /** Total affected task count (self + children). */
  totalDeleted: number;
}

/**
 * Calculate the cascade impact of deleting a task. Walks the parentId chain
 * transitively to count all descendants.
 */
export function computeTaskDeleteImpact(
  taskId: string,
  tasks: ReadonlyArray<Task>,
): TaskDeleteImpact {
  const descendants = new Set<string>();

  function collectDescendants(id: string) {
    for (const t of tasks) {
      if (t.parentId === id && !descendants.has(t.id)) {
        descendants.add(t.id);
        collectDescendants(t.id);
      }
    }
  }
  collectDescendants(taskId);

  // Count dependencies pointing TO any deleted task (surviving tasks lose
  // those edges).
  const deletedIds = new Set([taskId, ...descendants]);
  let dependencyCount = 0;
  for (const t of tasks) {
    if (!deletedIds.has(t.id)) {
      dependencyCount += t.dependencies.filter((d) => deletedIds.has(d.targetId)).length;
    }
  }

  return {
    childCount: descendants.size,
    dependencyCount,
    totalDeleted: 1 + descendants.size,
  };
}

export interface ResourceDeleteImpact {
  /** Number of tasks that currently have an assignment for this resource. */
  assignmentCount: number;
}

/**
 * Count how many tasks will lose their assignment when a resource is deleted.
 * `deleteResourceCommand` already strips assignments cascade; this is only
 * for the confirmation summary.
 */
export function computeResourceDeleteImpact(
  resourceId: string,
  tasks: ReadonlyArray<Task>,
): ResourceDeleteImpact {
  let assignmentCount = 0;
  for (const t of tasks) {
    if (t.assignments.some((a) => a.resourceId === resourceId)) {
      assignmentCount++;
    }
  }
  return { assignmentCount };
}
