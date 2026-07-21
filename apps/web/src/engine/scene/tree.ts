/**
 * Flat task list ↔ tree assembly (PRD §4.2.1, M1.9).
 *
 * Tasks are stored FLAT in the data model (each task has `parentId` and
 * `order`). The tree shape is materialised on demand for rendering and
 * algorithms (CPM, dependency resolution, summary aggregation).
 *
 * All functions are pure: input array is not mutated.
 */
import type { Task } from '@ganttly/schema';

export interface TreeNode<T = Task> {
  task: T;
  children: TreeNode<T>[];
  /** Depth in the tree, 0 = root. Useful for indentation. */
  depth: number;
  /** Path of ancestor ids from root to this node (exclusive of self). */
  ancestorIds: string[];
  /** WBS number string (e.g. `1.2.3`), filled in by `buildTree`. */
  wbsNumber: string;
}

/**
 * Assemble a flat task array into a tree. Stable on `order` field within
 * siblings. Orphan tasks (whose parentId refers to a missing id) are
 * promoted to top-level rather than dropped — this preserves data when a
 * parent is deleted but a child wasn't yet re-homed.
 *
 * Each TreeNode carries its `wbsNumber` (e.g. `1.2.3`), computed during
 * assembly so consumers don't need to traverse.
 */
export function buildTree(tasks: ReadonlyArray<Task>): TreeNode[] {
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);

  // Group children by parent.
  const childrenOf = new Map<string | null, Task[]>();
  for (const t of tasks) {
    const parent = t.parentId && byId.has(t.parentId) ? t.parentId : null;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(t);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  const build = (
    parentId: string | null,
    depth: number,
    ancestorIds: string[],
    pathPrefix: number[],
  ): TreeNode[] => {
    const list = childrenOf.get(parentId) ?? [];
    return list.map((task, idx) => {
      const wbs = [...pathPrefix, idx + 1].join('.');
      return {
        task,
        depth,
        ancestorIds,
        wbsNumber: wbs,
        children: build(task.id, depth + 1, [...ancestorIds, task.id], [...pathPrefix, idx + 1]),
      };
    });
  };

  return build(null, 0, [], []);
}

/**
 * Flatten the tree depth-first into a list, optionally skipping subtrees
 * whose root is in `collapsedSet`. Useful for the left task table (which
 * respects collapse state) and for the canvas row layout.
 */
export function flattenVisible(
  roots: ReadonlyArray<TreeNode>,
  collapsedSet: ReadonlySet<string>,
): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    out.push(node);
    if (collapsedSet.has(node.task.id)) return;
    for (const child of node.children) walk(child);
  };
  for (const r of roots) walk(r);
  return out;
}

/**
 * Flatten the entire tree, ignoring collapse state. Used for algorithms
 * that need every task regardless of UI state (e.g. CPM, dependency checks).
 */
export function flattenAll(roots: ReadonlyArray<TreeNode>): TreeNode[] {
  return flattenVisible(roots, new Set());
}

/**
 * Generate the WBS number for a node, e.g. `1.2.3`. The number reflects the
 * 1-indexed position within each parent's sorted children. Top-level tasks
 * are numbered `1`, `2`, etc.
 */
export function wbsNumber(node: TreeNode, roots: ReadonlyArray<TreeNode>): string {
  const path = [...node.ancestorIds, node.task.id];
  if (path.length === 0) return '';
  const parts: number[] = [];
  let siblings: ReadonlyArray<TreeNode> = roots;
  for (const id of path) {
    const idx = siblings.findIndex((n) => n.task.id === id);
    if (idx === -1) return ''; // not in tree
    parts.push(idx + 1);
    const found = siblings[idx];
    siblings = found ? found.children : [];
  }
  return parts.join('.');
}

/** Returns the task with the given id, or undefined. */
export function findTask(tasks: ReadonlyArray<Task>, id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

/**
 * Returns true if `candidateAncestorId` is an ancestor of `taskId`
 * (transitively, via parentId).
 */
export function isAncestor(
  tasks: ReadonlyArray<Task>,
  taskId: string,
  candidateAncestorId: string,
): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let cursor: Task | undefined = byId.get(taskId);
  while (cursor && cursor.parentId) {
    if (cursor.parentId === candidateAncestorId) return true;
    cursor = byId.get(cursor.parentId);
  }
  return false;
}
