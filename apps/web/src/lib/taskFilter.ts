/**
 * Task search & filter (editor-interaction-optimization-plan §4.4).
 *
 * The editor had no task-level search/filter before this. This module computes
 * the set of rows that should be visible given a search query and/or a filter,
 * and — critically — the set of collapsed ancestors that must be force-expanded
 * so matched rows hidden under collapsed parents actually appear.
 *
 * Design (plan §4.4 / §9.1):
 *   - Search and filter are NAVIGATION/UI state: they never enter the undo
 *     stack and are not persisted (they live in `useViewStore`, cleared on
 *     reload). They only affect WHAT is displayed, never the task hierarchy or
 *     persisted data.
 *   - Matching is done against the FULL tree (via `flattenAll`), NOT the
 *     `flattenVisible` collapse-aware list — otherwise tasks hidden under a
 *     collapsed parent could never be found (plan §4.4 acceptance: "搜索折叠
 *     层级中的任务时能自动展开并定位").
 *   - Filters target LEAF tasks (a summary isn't "overdue" or "unassigned" in
 *     a meaningful sense). A matched leaf whose ancestors are collapsed is made
 *     visible by force-expanding those ancestors in the render projection
 *     (without mutating the persisted `collapsedTaskIds`).
 *
 * The pure core is split out so it can be unit-tested without a DOM/store.
 */
import type { GanttlyFile, Task } from '@ganttly/schema';
import { buildTree, flattenAll, flattenVisible, type TreeNode } from '@/engine/scene';
import { computeCriticalPath } from '@/lib/cpm';
import { todayISO } from '@/engine/layout';

/** Available quick-filters. `'none'` = no filter active. */
export type TaskFilter = 'none' | 'unassigned' | 'criticalPath' | 'overdue';

/** A match predicate derived from the active filter (or null when 'none'). */
export type TaskFilterPredicate = (task: Task) => boolean;

export interface FilteredRows {
  /** Tree nodes to render, in display order. */
  rows: TreeNode[];
  /**
   * When non-null, a SET of collapsed ids to OVERRIDE the persisted collapse
   * state during rendering — the caller treats every id NOT in this set as
   * expanded (so matched rows under collapsed parents appear). When null the
   * caller uses the normal `flattenVisible` path (no active search/filter).
   */
  expandedOverride: Set<string> | null;
}

/**
 * Is the query non-empty after trimming? Whitespace-only queries are treated
 * as "no search" so the table shows everything.
 */
export function isSearchActive(query: string): boolean {
  return query.trim().length > 0;
}

export function isFilterActive(filter: TaskFilter): boolean {
  return filter !== 'none';
}

/** True when either a search query or a non-'none' filter is active. */
export function isAnyFilterActive(query: string, filter: TaskFilter): boolean {
  return isSearchActive(query) || isFilterActive(filter);
}

/**
 * Does `task` match the free-text query? Matches case-insensitively against
 * the task name OR its WBS number (e.g. "1.2"). A node reference is needed to
 * read the WBS; callers that don't have one can pass the task alone and use
 * `matchesSearchTask` instead (name-only).
 */
export function matchesSearch(task: Task, node: TreeNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  if (task.name.toLowerCase().includes(q)) return true;
  if (node.wbsNumber.toLowerCase().includes(q)) return true;
  return false;
}

/** Name-only search variant (no WBS) — used when the caller lacks a node. */
export function matchesSearchTask(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return task.name.toLowerCase().includes(q);
}

/**
 * Build the predicate for the structured filter. `'none'` yields null.
 *
 *   - `unassigned`  — leaf tasks with zero assignments.
 *   - `criticalPath`— leaf tasks on the critical path (float 0).
 *   - `overdue`     — leaf tasks whose end is before today AND progress < 100.
 *
 * Summary tasks are excluded from all three (a summary isn't "assigned" or
 * "overdue" in the same sense as a leaf). Milestones are treated as leaves
 * here — an unassigned/overdue milestone is still a meaningful filter hit.
 */
export function buildFilterPredicate(
  file: GanttlyFile,
  filter: TaskFilter,
): TaskFilterPredicate | null {
  if (filter === 'none') return null;

  // Pre-compute per-task data once so the predicate is O(1) per task.
  const childParentCount = new Set<string>();
  for (const t of file.tasks) if (t.parentId) childParentCount.add(t.parentId);

  const isLeaf = (t: Task): boolean => !childParentCount.has(t.id);

  const today = todayISO();

  if (filter === 'unassigned') {
    return (t: Task) => isLeaf(t) && t.assignments.length === 0;
  }

  if (filter === 'criticalPath') {
    const cpm = computeCriticalPath(file.tasks, file.calendar);
    const critical = cpm.criticalTaskIds;
    return (t: Task) => isLeaf(t) && critical.has(t.id);
  }

  // overdue
  return (t: Task) => isLeaf(t) && t.end < today && t.progress < 100;
}

/**
 * Pure core: compute the rows to render and (optionally) the collapsed-ids
 * override needed to reveal matches under collapsed ancestors.
 *
 * When nothing is active, returns `{ rows, expandedOverride: null }` where
 * `rows` is the plain `flattenVisible` result over the persisted collapse
 * state — i.e. the EXACT pre-filter path, so zero-filter behaviour is
 * identical to before (no regression risk, plan risk note).
 *
 * When a search/filter is active:
 *   1. Walk the FULL tree (`flattenAll`) to find matches (collapse-agnostic).
 *   2. Collect the set of matched node ids.
 *   3. Compute the override: a copy of `collapsedTaskIds` with every matched
 *      node's ancestors removed (force-expanded), so matched rows appear.
 *   4. Re-flatten with the override, then keep only nodes that are EITHER
 *      matched OR an ancestor of a match (so the table shows the matched rows
 *      in their indented hierarchy, not the whole tree).
 */
export function computeFilteredRows(
  file: GanttlyFile,
  query: string,
  filter: TaskFilter,
): FilteredRows {
  const tree = buildTree(file.tasks);

  // Fast path: nothing active → identical to the original render path.
  if (!isAnyFilterActive(query, filter)) {
    const rows = flattenVisible(tree, new Set(file.viewState.collapsedTaskIds));
    return { rows, expandedOverride: null };
  }

  const predicate = buildFilterPredicate(file, filter);
  const all = flattenAll(tree);

  // Node lookup so we can read WBS for search matching.
  const nodeByTaskId = new Map(all.map((n) => [n.task.id, n]));

  // Determine the set of matched task ids.
  const matchedIds = new Set<string>();
  for (const node of all) {
    let hit = true;
    if (isSearchActive(query)) hit = matchesSearch(node.task, node, query);
    if (hit && predicate) hit = predicate(node.task);
    if (hit) matchedIds.add(node.task.id);
  }

  // The collapsed override: start from the persisted collapsed set, then drop
  // any collapsed ancestor of a matched node so it becomes visible.
  const collapsedOverride = new Set(file.viewState.collapsedTaskIds);
  for (const id of matchedIds) {
    const node = nodeByTaskId.get(id);
    if (!node) continue;
    for (const ancId of node.ancestorIds) collapsedOverride.delete(ancId);
  }

  // Re-flatten with the override (matched subtrees now visible), then keep
  // only matched nodes + their ancestors (for indentation context).
  const visible = flattenVisible(tree, collapsedOverride);
  const keep = new Set<string>();
  for (const id of matchedIds) {
    const node = nodeByTaskId.get(id);
    if (!node) continue;
    keep.add(id);
    for (const ancId of node.ancestorIds) keep.add(ancId);
  }
  const rows = visible.filter((n) => keep.has(n.task.id));

  return { rows, expandedOverride: collapsedOverride };
}
