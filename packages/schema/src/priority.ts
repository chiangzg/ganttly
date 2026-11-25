/**
 * Priority constants + runtime guard (priority-matrix spec §2.1).
 *
 * `schema.json` constrains `Task.priority` to integers 1..4. This module is the
 * TypeScript-side counterpart for paths that check the value by hand instead of
 * running the whole document through AJV (normalize, MCP, UI).
 */
import type { TaskPriority } from './types.js';

/** Every valid priority, lowest number first (P1 is the most urgent quadrant). */
export const TASK_PRIORITIES = [1, 2, 3, 4] as const satisfies readonly TaskPriority[];

export function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 1 || value === 2 || value === 3 || value === 4;
}
