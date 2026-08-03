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

/**
 * Cascade impact of deleting MULTIPLE tasks at once (plan §4.6 batch delete).
 *
 * The selected ids are closed transitively under `parentId` (same union as
 * `batchDeleteTasksCommand`), so a parent selected alongside its child is
 * counted once — never double-counted (plan §4.6 验收 "删除父子任务同时被选中
 * 时避免重复计数"). `childCount` is intentionally omitted: it is ambiguous for
 * a multi-root set (a selected child is neither a "child" nor a "root"); the
 * confirmation dialog surfaces `totalDeleted` instead.
 */
export function computeBatchDeleteImpact(
  ids: ReadonlyArray<string>,
  tasks: ReadonlyArray<Task>,
): { totalDeleted: number; dependencyCount: number } {
  const idsToDelete = new Set<string>(ids);
  // Close under parentId: deleting a parent removes its subtree.
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (t.parentId && idsToDelete.has(t.parentId) && !idsToDelete.has(t.id)) {
        idsToDelete.add(t.id);
        changed = true;
      }
    }
  }
  // Count dependency edges pointing TO any deleted task (survivors lose them).
  let dependencyCount = 0;
  for (const t of tasks) {
    if (!idsToDelete.has(t.id)) {
      dependencyCount += t.dependencies.filter((d) => idsToDelete.has(d.targetId)).length;
    }
  }
  return {
    totalDeleted: idsToDelete.size,
    dependencyCount,
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
