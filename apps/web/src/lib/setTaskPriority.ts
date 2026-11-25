/**
 * Set (or clear) a task's priority from OUTSIDE the drawer. The matrix drag and
 * the context menu both go through here (priority-matrix spec §3.2, §4.5).
 *
 * - No-op when the value is already the current one: the store records an undo
 *   entry even for a no-op command.
 * - Uses `updateTaskCommand` (no rollup): a priority never changes dates.
 * - Bumps the one-shot `prioritySyncRequest` so a drawer open on this task
 *   re-bases its draft instead of showing — or saving back — a stale value (§4.8).
 */
import type { TaskPriority } from '@ganttly/schema';
import { updateTaskCommand, useProjectStore } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';

/** Returns true when a command was dispatched. */
export function setTaskPriority(taskId: string, priority: TaskPriority | undefined): boolean {
  const task = useProjectStore.getState().file.tasks.find((t) => t.id === taskId);
  if (!task || task.priority === priority) return false;
  useProjectStore.getState().dispatch(updateTaskCommand(taskId, { priority }));
  useViewStore.getState().requestPrioritySync(taskId);
  return true;
}
