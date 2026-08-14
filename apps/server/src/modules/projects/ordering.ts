/**
 * MCP task ordering helpers (spec §10.3 `afterTaskId` / §10.5 `position`).
 *
 * The domain `addTask` takes a raw `order` value (no sibling repack), while
 * `moveTaskWithRollup` takes a 0-based insert *index* and repacks the group
 * itself (see `packages/domain` `repackWithInsertion`). These helpers bridge
 * the MCP user-facing position spec onto each command's expected input and
 * enforce the "do not move into your own descendant" invariant.
 */
import type { Task } from '@ganttly/schema';
import type { MovePosition } from '@ganttly/api-contract';
import { ApiErrorCode } from '@ganttly/api-contract';
import { HttpError } from '../errors';

/** Siblings of `parentId`, sorted by order then name for stable ordering. */
export function sortedSiblings(tasks: ReadonlyArray<Task>, parentId: string | null): Task[] {
  return tasks
    .filter((t) => t.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export interface InsertionPlan {
  /** Order value for the new task. */
  order: number;
  /** Bump every sibling of `parentId` whose order is `>=` this value by 1. */
  shiftThreshold: number;
}

/**
 * Resolve the order for a newly created task under `parentId`, optionally
 * placed immediately after `afterTaskId`. Throws VALIDATION_FAILED when
 * `afterTaskId` is not a sibling of `parentId` (spec §10.3: must belong to the
 * same sibling set).
 */
export function planInsertion(
  tasks: ReadonlyArray<Task>,
  parentId: string | null,
  afterTaskId: string | null | undefined,
): InsertionPlan {
  const siblings = sortedSiblings(tasks, parentId);
  if (!afterTaskId) {
    const order = siblings.length ? siblings[siblings.length - 1]!.order + 1 : 0;
    return { order, shiftThreshold: Number.POSITIVE_INFINITY };
  }
  const after = siblings.find((t) => t.id === afterTaskId);
  if (!after) {
    throw new HttpError(
      ApiErrorCode.VALIDATION_FAILED,
      'afterTaskId must belong to the same sibling set as the new task',
    );
  }
  const order = after.order + 1;
  return { order, shiftThreshold: order };
}

/**
 * Convert a move {@link MovePosition} into the 0-based insert index expected by
 * the domain `moveTaskWithRollup`. Validates that any referenced sibling exists.
 */
export function moveInsertIndex(
  tasks: ReadonlyArray<Task>,
  newParentId: string | null,
  position: MovePosition,
  movingTaskId: string,
): number {
  const siblings = sortedSiblings(tasks, newParentId).filter((t) => t.id !== movingTaskId);
  switch (position.kind) {
    case 'first':
      return 0;
    case 'last':
      return siblings.length;
    case 'before':
    case 'after': {
      const idx = siblings.findIndex((t) => t.id === position.taskId);
      if (idx < 0) {
        throw new HttpError(
          ApiErrorCode.VALIDATION_FAILED,
          `position anchor ${position.taskId} is not a sibling of the destination`,
        );
      }
      return position.kind === 'before' ? idx : idx + 1;
    }
  }
}

/**
 * Whether `candidateParentId` is `taskId` itself or one of its descendants.
 * Used to reject moves that would create a cycle (spec §10.5).
 */
export function isSelfOrDescendant(
  tasks: ReadonlyArray<Task>,
  taskId: string,
  candidateParentId: string,
): boolean {
  if (candidateParentId === taskId) return true;
  const descendants = new Set<string>([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (t.parentId !== null && descendants.has(t.parentId) && !descendants.has(t.id)) {
        descendants.add(t.id);
        changed = true;
      }
    }
  }
  return descendants.has(candidateParentId);
}
