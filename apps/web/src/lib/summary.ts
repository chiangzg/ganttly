/**
 * Summary task aggregation — pure functions for computing rollup values.
 *
 * A "summary task" is any task that has children (other tasks with
 * `parentId === task.id`). Summary tasks don't carry their own dates /
 * duration / progress; instead those values are *rolled up* from children.
 *
 * Weighted progress algorithm:
 *   weight(child)      = child is summary ? rollupMap[child.id].duration : child.duration
 *   childProgress      = child is summary ? rollupMap[child.id].progress : child.progress
 *   progress = Σ(childProgress × weight) / Σ(weight)
 *   - All children progress === 100 → parent = 100
 *   - Σ(weight) === 0 → simple arithmetic mean, rounded
 *   - Otherwise Math.round()
 *
 * Date range:
 *   start = min(children.start)   (ISO YYYY-MM-DD string compare)
 *   end   = max(children.end)
 *   duration = Σ(children.duration)
 */
import type { Task, Resource } from '@ganttly/schema';
import { computeTaskPersonDays } from './cost';

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
  /** Sum of children person-days (P1 feature two — additive, NOT weighted). */
  personDays: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute aggregated values for a set of direct children.
 *
 * For summary children, use their already-rolled-up duration as weight AND
 * their rolled-up progress (looked up via `rollupMap`). Leaf children use
 * their own `duration` / `progress`.
 */
export function computeRollup(
  children: ReadonlyArray<Task>,
  rollupMap?: Map<string, RollupResult>,
  resources: ReadonlyArray<Resource> = [],
): RollupResult | null {
  if (children.length === 0) return null;

  let minStart = children[0]!.start;
  let maxEnd = children[0]!.end;
  let totalDuration = 0;
  let weightedProgressSum = 0;
  let weightSum = 0;
  let allCompleteProgress = true;
  let simpleSum = 0;
  let totalPersonDays = 0;

  for (const child of children) {
    // Time range
    if (child.start < minStart) minStart = child.start;
    if (child.end > maxEnd) maxEnd = child.end;

    // Determine weight: use rolled-up duration for summary children
    const childRollup = rollupMap?.get(child.id);
    const weight = childRollup ? childRollup.duration : child.duration;
    // For summary children, use the rolled-up progress (not the stale task value),
    // otherwise deeply nested summaries would compute progress against 0.
    const childProgress = childRollup ? childRollup.progress : child.progress;

    totalDuration += child.duration;
    weightedProgressSum += childProgress * weight;
    weightSum += weight;
    simpleSum += childProgress;

    // Person-days: additive rollup. Summary children use their rolled-up value
    // (already summed from grandchildren); leaf children compute their own.
    // NOTE: this is pure addition — it must NOT interact with the weighted-
    // average progress logic above (G9 risk #1).
    totalPersonDays += childRollup
      ? childRollup.personDays
      : computeTaskPersonDays(child, resources);

    if (childProgress < 100) allCompleteProgress = false;
  }

  // Progress calculation
  let progress: number;
  if (allCompleteProgress) {
    progress = 100;
  } else if (weightSum === 0) {
    // Zero-division guard: simple arithmetic mean
    progress = Math.round(simpleSum / children.length);
  } else {
    progress = Math.round(weightedProgressSum / weightSum);
  }

  return {
    start: minStart,
    end: maxEnd,
    duration: totalDuration,
    progress,
    personDays: Math.round(totalPersonDays * 100) / 100,
  };
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
 * Uses bottom-up traversal (direct parent first) so child summaries are
 * resolved before their parents. Returns an array of `{id, patch}` for every
 * ancestor that needs updating.
 *
 * Note: `changedTaskId` itself is NOT recomputed — it is assumed to be either a
 * leaf task or already up-to-date. Use {@link recomputeSelfAndAncestors} when
 * you need to recompute the task itself as well (e.g. after a child moves in
 * or out of it).
 */
export function computeCascadeRollup(
  tasks: ReadonlyArray<Task>,
  changedTaskId: string,
): Array<{ id: string; patch: Partial<Task> }> {
  return computeCascadeRollupWithMap(tasks, changedTaskId, new Map());
}

/**
 * Same as {@link computeCascadeRollup} but accepts a pre-seeded `rollupMap`
 * (e.g. containing the rolled-up values of `changedTaskId` itself) so that
 * ancestors can reference summary descendants below the changed task.
 */
function computeCascadeRollupWithMap(
  tasks: ReadonlyArray<Task>,
  changedTaskId: string,
  initialMap: Map<string, RollupResult>,
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
  const rollupMap = new Map(initialMap);
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
 * Recompute `taskId` itself (if it is still a summary) AND all of its
 * ancestors, returning `{id, patch}` entries for each.
 *
 * Used after a structural change that may turn a task into a leaf or change
 * its set of children — e.g. `moveTask` moving a child in or out. The plain
 * {@link computeCascadeRollup} skips `taskId` itself, which would leave the
 * moved task's old/new parent with stale aggregated values.
 */
export function recomputeSelfAndAncestors(
  tasks: ReadonlyArray<Task>,
  taskId: string,
): Array<{ id: string; patch: Partial<Task> }> {
  const childrenOf = buildChildrenIndex(tasks);
  const children = childrenOf.get(taskId);

  if (children && children.length > 0) {
    // `taskId` is still a summary — compute its own rollup, seed the map so
    // ancestors see the fresh value, then cascade up.
    const rollupMap = new Map<string, RollupResult>();
    const selfRollup = computeRollup(children, rollupMap);
    if (!selfRollup) return [];
    rollupMap.set(taskId, selfRollup);

    const selfPatch: { id: string; patch: Partial<Task> } = {
      id: taskId,
      patch: {
        start: selfRollup.start,
        end: selfRollup.end,
        duration: selfRollup.duration,
        progress: selfRollup.progress,
      },
    };
    const ancestors = computeCascadeRollupWithMap(tasks, taskId, rollupMap);
    return [selfPatch, ...ancestors];
  }

  // `taskId` has no children (e.g. its only child just moved out). It is now a
  // leaf — we don't rewrite its fields (they remain whatever they were), but
  // we still must recompute every ancestor, since their aggregated values were
  // derived from `taskId`'s former children.
  return computeCascadeRollupWithMap(tasks, taskId, new Map());
}

/**
 * Compute rollup for ALL summary tasks in the project.
 *
 * Post-order traversal ensures every summary is resolved after its children.
 * Used by the assembly layer for rendering summary bars.
 */
export function computeAllRollups(
  tasks: ReadonlyArray<Task>,
  resources: ReadonlyArray<Resource> = [],
): Map<string, RollupResult> {
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

    const rollup = computeRollup(children, rollupMap, resources);
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
