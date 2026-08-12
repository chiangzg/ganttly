/**
 * In-memory task clipboard shared by TaskTable (keyboard shortcuts) and
 * ContextMenu (mouse), PRD §3.10.
 *
 * Intentionally not the async browser ClipboardAPI:
 * - task data isn't plain text,
 * - the permission prompt would interrupt flow,
 * - pasting across tabs isn't a requirement.
 *
 * A module-level slot survives drawer open/close and is enough for
 * single-window use.
 */
import type { Task } from '@ganttly/schema';

export interface TaskClipboard {
  task: Task | null;
  /** When true, paste deletes the source (cut); when false, paste copies. */
  cutMode: boolean;
}

export const clipboard: TaskClipboard = { task: null, cutMode: false };

/** Copy a task into the clipboard (copy mode). */
export function copyToClipboard(task: Task): void {
  clipboard.task = { ...task };
  clipboard.cutMode = false;
}

/** Copy a task into the clipboard and mark for deletion on paste (cut mode). */
export function cutToClipboard(task: Task): void {
  clipboard.task = { ...task };
  clipboard.cutMode = true;
}

/** Build a fresh task object ready to insert, or null if clipboard is empty. */
export function buildPasteTemplate(nameSuffix: string): Task | null {
  const src = clipboard.task;
  if (!src) return null;
  const template: Task = {
    ...src,
    // Fresh id is assigned by the caller via nanoid; keep template id empty
    // until then — but we need a unique id at dispatch time, so the caller
    // overrides this.
    id: src.id,
    name: `${src.name} ${nameSuffix}`.trim(),
    dependencies: [],
  };
  return template;
}

/** Clear the clipboard after a cut-paste completes. */
export function clearClipboard(): void {
  clipboard.task = null;
  clipboard.cutMode = false;
}
