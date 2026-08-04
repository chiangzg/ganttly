/**
 * Shared root-task creation helper (editor-interaction-optimization-plan §3.1/§5.1).
 *
 * Previously this logic lived inline inside `Toolbar.addRootTask`. It is now
 * extracted so the SAME orchestration is reused by every task-creation entry
 * point:
 *   - the editor Toolbar (legacy single entry, kept for parity)
 *   - the TaskTable header "+" button (§3.1 — task creation near the task list)
 *   - the zero-task empty-state CTA (§5.2)
 *
 * Semantics are identical to the historical `addRootTask`:
 *   1. create a default task anchored at today, as a new root
 *   2. dispatch `addTaskCommand` (undoable)
 *   3. select the new task atomically — selection is ephemeral (useViewStore,
 *      plan §9.1), mirrored into `file.viewState.selectedTaskId` so the drawer
 *      and bars see it without touching those consumers
 *   4. reveal the new task's bar so the user doesn't hunt for it (plan §2.1)
 *   5. open the edit drawer
 *
 * Reading the placeholder name is the caller's job (it is i18n-driven), so this
 * helper stays free of `useTranslation` and can run from non-component contexts.
 */
import { createDefaultTask } from '@ganttly/schema';
import { nanoid } from 'nanoid';

import { todayISO } from '@/engine/layout';
import { useProjectStore, addTaskCommand } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { revealTask } from '@/lib/revealTask';

/**
 * Create a new root task at today and immediately select + reveal + open it.
 *
 * @param placeholderName i18n-localized placeholder name to seed the task with
 *   (e.g. `t('table.placeholderName')`). The caller decides localization.
 */
export function createRootTask(placeholderName: string): void {
  const { file, dispatch } = useProjectStore.getState();
  const start = todayISO();
  const id = nanoid(10);
  const order = file.tasks.filter((x) => x.parentId === null).length;
  const task = createDefaultTask({
    id,
    name: placeholderName,
    start,
    parentId: null,
    order,
  });
  // Select the new task atomically with creating it, then open the drawer.
  dispatch(addTaskCommand(task, null, order));
  // §4.6: selection is ephemeral now (useViewStore); selectSingle mirrors
  // the anchor into file.viewState.selectedTaskId for the drawer.
  useViewStore.getState().selectSingle(id);
  // Reveal the new task's bar so the user doesn't have to hunt for it when
  // the project origin is months away from today (plan §2.1). Runs after the
  // dispatch commits so computeRevealTarget sees the new task.
  revealTask(id);
  useViewStore.getState().openDrawer();
}
