/**
 * Task drag-drop target geometry (editor-interaction-optimization-plan §2.3, §6.3).
 *
 * When the user drags a task row over another row, the pointer's vertical
 * position within the target row decides which of three drop zones is active:
 *
 *   - `before`  — insert as the previous sibling of the target (top band).
 *   - `inside`  — become the last child of the target (middle band).
 *   - `after`   — insert as the next sibling of the target (bottom band).
 *
 * The pure core is split out so it can be unit-tested without a DOM/store.
 */
import type { Task } from '@ganttly/schema';

export type TaskDropPosition = 'before' | 'inside' | 'after';

/**
 * A fully-resolved drop target. `parentId` and `order` are pre-computed so the
 * `onDrop` handler can hand them straight to the move command without having
 * to re-derive them from the file (and without each caller duplicating the
 * sibling-walking logic).
 *
 * `invalid: true` marks positions that must not be dropped onto (the dragged
 * task is the target itself, or a descendant of the dragged task). The UI
 * still tracks these so it can render a "no-drop" cursor without re-running
 * the geometry.
 */
export interface TaskDropTarget {
  taskId: string;
  position: TaskDropPosition;
  /** New parentId for the moved task. */
  parentId: string | null;
  /** New order among the new siblings. */
  order: number;
  /** Whether this drop is forbidden (descendant / self). */
  invalid: boolean;
}

/** Fractional height of the top and bottom bands; the middle is `inside`. */
const EDGE_FRACTION = 0.25;

/**
 * Decide which drop zone the pointer falls into, given the pointer's Y offset
 * within the target row (0 = top edge) and the row height.
 *
 * Pure / deterministic — does not read the DOM.
 */
export function computeDropPosition(offsetWithinRow: number, rowHeight: number): TaskDropPosition {
  const ratio = rowHeight > 0 ? offsetWithinRow / rowHeight : 0.5;
  if (ratio < EDGE_FRACTION) return 'before';
  if (ratio > 1 - EDGE_FRACTION) return 'after';
  return 'inside';
}

/** True if `maybeDescendantId` is a descendant of `ancestorId` (or the same task). */
function isSelfOrDescendant(
  tasks: ReadonlyArray<Task>,
  ancestorId: string,
  maybeDescendantId: string,
): boolean {
  if (ancestorId === maybeDescendantId) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let cursor = byId.get(maybeDescendantId);
  while (cursor && cursor.parentId) {
    if (cursor.parentId === ancestorId) return true;
    cursor = byId.get(cursor.parentId);
  }
  return false;
}

/**
 * Resolve the concrete new (parentId, order) for a drop, along with whether it
 * is forbidden. Used by `onDragOver` (to render the preview) and `onDrop` (to
 * dispatch the move).
 *
 * @param draggedId  The task being dragged.
 * @param targetId   The row the pointer is over.
 * @param position   Drop zone from `computeDropPosition`.
 * @param tasks      Current flat task list (read-only).
 */
export function resolveDropTarget(
  draggedId: string,
  targetId: string,
  position: TaskDropPosition,
  tasks: ReadonlyArray<Task>,
): TaskDropTarget {
  const target = tasks.find((t) => t.id === targetId);
  if (!target) {
    return { taskId: targetId, position, parentId: null, order: 0, invalid: true };
  }

  // Self / descendant guard: never drop onto yourself or your own subtree.
  const invalid = isSelfOrDescendant(tasks, draggedId, targetId);

  if (position === 'inside') {
    const childCount = tasks.filter((t) => t.parentId === targetId && t.id !== draggedId).length;
    return {
      taskId: targetId,
      position,
      parentId: targetId,
      order: childCount,
      invalid,
    };
  }

  // before / after → sibling of target, in target's parent.
  const parentId = target.parentId;
  if (position === 'before') {
    // Inserting before target = take target's current index among siblings
    // (excluding the dragged task, which will be removed first).
    const siblings = tasks
      .filter((t) => t.parentId === parentId && t.id !== draggedId)
      .sort((a, b) => a.order - b.order);
    const idx = siblings.findIndex((t) => t.id === targetId);
    return {
      taskId: targetId,
      position,
      parentId,
      order: idx === -1 ? 0 : idx,
      invalid,
    };
  }
  // after
  const siblings = tasks
    .filter((t) => t.parentId === parentId && t.id !== draggedId)
    .sort((a, b) => a.order - b.order);
  const idx = siblings.findIndex((t) => t.id === targetId);
  return {
    taskId: targetId,
    position,
    parentId,
    order: idx === -1 ? 0 : idx + 1,
    invalid,
  };
}
