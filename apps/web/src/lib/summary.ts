/**
 * Summary task aggregation — pure functions for computing rollup values.
 *
 * A "summary task" is any task that has children (other tasks with
 * `parentId === task.id`). Summary tasks don't carry their own dates /
 * duration / progress; instead those values are *rolled up* from children.
 *
 * Weighted progress algorithm:
 *   weight(child) = child is summary ? rollupMap[child.id].duration : child.duration
 *   progress = Σ(child.progress × weight) / Σ(weight)
 *   - All children progress === 100 → parent = 100
 *   - Σ(weight) === 0 → simple arithmetic mean, rounded
 *   - Otherwise Math.round()
 *
 * Date range:
 *   start = min(children.start)   (ISO YYYY-MM-DD string compare)
 *   end   = max(children.end)
 *   duration = Σ(children.duration)
 */
import type { Task } from '@ganttly/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RollupResult {
  /** ISO date, min of children start. */
  start: string;
  /** ISO date, max of children end. */
  end: string;
  /** Sum of children durations. */
  duration: number;
  /** 0-100, weighted average. */
  progress: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute aggregated values for a set of direct children.
 *
 * For summary children, use their already-rolled-up duration as weight
 * (looked up via `rollupMap`).
 */
export function computeRollup(
  children: ReadonlyArray<Task>,
  rollupMap?: Map<string, RollupResult>,
): RollupResult | null {
  if (children.length === 0) return null;

  let minStart = children[0]!.start;
  let maxEnd = children[0]!.end;
  let totalDuration = 0;
  let weightedProgressSum = 0;
  let weightSum = 0;
  let allComplete = true;

  for (const child of children) {
    // Time range
    if (child.start < minStart) minStart = child.start;
    if (child.end > maxEnd) maxEnd = child.end;

    // Determine weight: use rolled-up duration for summary children
    const childRollup = rollupMap?.get(child.id);
    const weight = childRollup ? childRollup.duration : child.duration;

    totalDuration += child.duration;
    weightedProgressSum += child.progress * weight;
    weightSum += weight;

    if (child.progress < 100) allComplete = false;
  }

  // Progress calculation
  let progress: number;
  if (allComplete) {
    progress = 100;
  } else if (weightSum === 0) {
    // Zero-division guard: simple arithmetic mean
    progress = Math.round(children.reduce((sum, c) => sum + c.progress, 0) / children.length);
  } else {
    progress = Math.round(weightedProgressSum / weightSum);
  }

  return { start: minStart, end: maxEnd, duration: totalDuration, progress };
}

/**
 * Check if a task has children (is a summary task).
 */
export function isSummaryTask(taskId: string, tasks: ReadonlyArray<Task>): boolean {
  return tasks.some((t) => t.parentId === taskId);
}

/**
 * Compute rollup patches for all ancestors of `changedTaskId`.
 *
 * Uses post-order traversal (leaves first) so child summaries are resolved
 * before their parents. Returns an array of `{id, patch}` for every ancestor
 * that needs updating.
 */
export function computeCascadeRollup(
  tasks: ReadonlyArray<Task>,
  changedTaskId: string,
): Array<{ id: string; patch: Partial<Task> }> {
  // 1. Build children index
  const childrenOf = buildChildrenIndex(tasks);

  // 2. Walk up from changedTaskId to collect ancestor chain
  const taskById = new Map<string, Task>();
  for (const t of tasks) taskById.set(t.id, t);

  const ancestors: Task[] = [];
  let current = taskById.get(changedTaskId);
  if (!current) return [];

  while (current?.parentId) {
    const parent = taskById.get(current.parentId);
    if (!parent) break;
    ancestors.push(parent);
    current = parent;
  }

  if (ancestors.length === 0) return [];

  // 3. Process bottom-up (ancestors[0] is the direct parent → process first)
  const rollupMap = new Map<string, RollupResult>();
  const results: Array<{ id: string; patch: Partial<Task> }> = [];

  for (const ancestor of ancestors) {
    const children = childrenOf.get(ancestor.id) ?? [];
    const rollup = computeRollup(children, rollupMap);
    if (!rollup) continue;

    // Store for higher-level ancestors to reference
    rollupMap.set(ancestor.id, rollup);

    const patch: Partial<Task> = {
      start: rollup.start,
      end: rollup.end,
      duration: rollup.duration,
      progress: rollup.progress,
    };
    results.push({ id: ancestor.id, patch });
  }

  return results;
}

/**
 * Compute rollup for ALL summary tasks in the project.
 *
 * Post-order traversal ensures every summary is resolved after its children.
 * Used by the assembly layer for rendering summary bars.
 */
export function computeAllRollups(tasks: ReadonlyArray<Task>): Map<string, RollupResult> {
  const childrenOf = buildChildrenIndex(tasks);
  const rollupMap = new Map<string, RollupResult>();

  // Post-order DFS
  const visited = new Set<string>();

  function visit(taskId: string): void {
    if (visited.has(taskId)) return;
    visited.add(taskId);

    const children = childrenOf.get(taskId);
    if (!children || children.length === 0) return; // leaf — no rollup

    // Visit children first (post-order)
    for (const child of children) {
      visit(child.id);
    }

    const rollup = computeRollup(children, rollupMap);
    if (rollup) {
      rollupMap.set(taskId, rollup);
    }
  }

  // Visit every task that has children
  for (const task of tasks) {
    if (childrenOf.has(task.id)) {
      visit(task.id);
    }
  }

  return rollupMap;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildChildrenIndex(tasks: ReadonlyArray<Task>): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parentId) {
      const list = map.get(t.parentId);
      if (list) list.push(t);
      else map.set(t.parentId, [t]);
    }
  }
  return map;
}
