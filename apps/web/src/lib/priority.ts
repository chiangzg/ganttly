/**
 * Priority presentation helpers (priority-matrix spec §2.1).
 *
 * Labels live in i18n (`priority.*`). Colours live in CSS tokens
 * (`--color-priority-1..4`) so the DOM tags and the Canvas stripe share one
 * source. Tailwind only keeps class names it can see verbatim, so the
 * per-quadrant classes are spelled out here instead of composed at runtime.
 */
import { TASK_PRIORITIES } from '@ganttly/schema';
import type { TaskPriority } from '@ganttly/schema';

export { TASK_PRIORITIES };
export type { TaskPriority };

/** Short mark shown in tree rows, cards and menus — the letter is never dropped,
 * so colour is never the only signal. */
export const PRIORITY_TAG: Record<TaskPriority, string> = {
  1: 'P1',
  2: 'P2',
  3: 'P3',
  4: 'P4',
};

/** Soft quadrant-tinted chip / active segment (keep literal for Tailwind). */
export const PRIORITY_TAG_CLASS: Record<TaskPriority, string> = {
  1: 'bg-priority-1/15 text-priority-1',
  2: 'bg-priority-2/15 text-priority-2',
  3: 'bg-priority-3/15 text-priority-3',
  4: 'bg-priority-4/15 text-priority-4',
};

/** `rgb(...)` for the places a Tailwind class cannot reach (inline styles). */
export const priorityColor = (priority: TaskPriority): string =>
  `rgb(var(--color-priority-${priority}))`;
