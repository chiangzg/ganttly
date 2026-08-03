/**
 * Task position predicates (editor-interaction-optimization-plan §5.4).
 *
 * The move/indent/outdent code paths used to recompute "am I at the edge?"
 * four separate times (TaskTable.moveSibling, TaskTable.indentOrOutdent,
 * ContextMenu.onIndent, ContextMenu.onOutdent), each inlining its own check.
 * §5.4 requires the context menu to visibly DISABLE these actions when they
 * would be no-ops. This pure helper centralizes the four booleans so both the
 * menu (for disabled state) and the action handlers (for guards) share one
 * definition of truth.
 *
 * Definitions (matching the existing no-op guards):
 *   - canMoveUp:   not the first sibling  (idx > 0)
 *   - canMoveDown: not the last sibling   (idx < siblings.length - 1)
 *   - canIndent:   has a previous sibling to become a child of (idx > 0)
 *   - canOutdent:  has a parent           (parentId !== null)
 *
 * Pure & store-free so it can be unit-tested directly.
 */
import type { Task } from '@ganttly/schema';

export interface TaskPositionInfo {
  /** Alt+↑ / 上移: a previous sibling exists to swap with. */
  canMoveUp: boolean;
  /** Alt+↓ / 下移: a next sibling exists to swap with. */
  canMoveDown: boolean;
  /** Tab / 降级 (indent): a previous sibling exists to nest under. */
  canIndent: boolean;
  /** Shift+Tab / 升级 (outdent): task has a parent to promote out of. */
  canOutdent: boolean;
}

/**
 * Compute the four move/indent/outdent applicability flags for `taskId` within
 * the given task list. Returns all-false if the task is not found.
 */
export function computeTaskPosition(taskId: string, tasks: ReadonlyArray<Task>): TaskPositionInfo {
  const me = tasks.find((t) => t.id === taskId);
  if (!me) {
    return { canMoveUp: false, canMoveDown: false, canIndent: false, canOutdent: false };
  }
  const siblings = tasks
    .filter((t) => t.parentId === me.parentId)
    .sort((a, b) => a.order - b.order);
  const idx = siblings.findIndex((t) => t.id === taskId);
  const atFirst = idx <= 0;
  const atLast = idx === siblings.length - 1;
  return {
    canMoveUp: !atFirst,
    canMoveDown: !atLast,
    canIndent: !atFirst,
    canOutdent: me.parentId !== null,
  };
}
