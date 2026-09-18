/**
 * Dependency-graph closure traversal (dependency-chain spec §4).
 *
 * Computes the transitive predecessor ("upstream" / 过去) and successor
 * ("downstream" / 未来) sets of one origin task, each node annotated with its
 * BFS depth from the origin. The depths drive the downstream pulse animation's
 * per-level stagger (spec §3.3) and any future "distance from focus" UI.
 *
 * Semantics follow the raw dependency edges — the same graph `computeArrows`
 * renders — NOT the leaf-only CPM graph: legacy files may contain edges
 * touching summary tasks, and those must still highlight. Missing `targetId`
 * references and self-loops are tolerated (skipped), and existing-data cycles
 * terminate via the visited set.
 */

import type { Task } from '@ganttly/schema';

export interface DependencyClosure {
  /** The task the chain was computed from. Never a member of the two maps. */
  originId: string;
  /**
   * Transitive predecessors of the origin (tasks the origin depends on,
   * directly or indirectly). Depth 1 = a direct predecessor.
   */
  upstream: Map<string, number>;
  /**
   * Transitive successors of the origin (tasks that depend on it, directly or
   * indirectly). Depth 1 = a direct successor. Drives the pulse stagger.
   */
  downstream: Map<string, number>;
}

/**
 * Compute the upstream/downstream closure of `originId`. Returns `null` when
 * the origin id is not present in `tasks` (e.g. stale selection after delete)
 * — callers treat that as "no highlight".
 */
export function computeDependencyClosure(
  tasks: ReadonlyArray<Task>,
  originId: string,
): DependencyClosure | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (!byId.has(originId)) return null;

  // A task's own `dependencies` list its incoming edges (targetId =
  // predecessor). Reverse them once for successor adjacency (same shape as
  // `wouldCreateCycle` / `cascadeSchedule`).
  const successorsOf = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!byId.has(dep.targetId) || dep.targetId === task.id) continue;
      const list = successorsOf.get(dep.targetId) ?? [];
      list.push(task.id);
      successorsOf.set(dep.targetId, list);
    }
  }
  const predecessorsOf = (id: string): Iterable<string> => {
    const out: string[] = [];
    for (const dep of byId.get(id)!.dependencies) {
      if (byId.has(dep.targetId) && dep.targetId !== id) out.push(dep.targetId);
    }
    return out;
  };
  const successorsAdj = (id: string): Iterable<string> => successorsOf.get(id) ?? [];

  return {
    originId,
    upstream: bfsDepths(predecessorsOf, originId),
    downstream: bfsDepths(successorsAdj, originId),
  };
}

/**
 * Breadth-first shortest-depth map over `adj`, excluding the origin itself.
 * BFS (not DFS) so a node reachable through both a long and a short path gets
 * the SHORT depth — deterministic stagger timing regardless of edge order.
 */
function bfsDepths(adj: (id: string) => Iterable<string>, originId: string): Map<string, number> {
  const depths = new Map<string, number>();
  let frontier: string[] = [originId];
  let depth = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adj(id)) {
        if (neighbor === originId || depths.has(neighbor)) continue;
        depths.set(neighbor, depth + 1);
        next.push(neighbor);
      }
    }
    frontier = next;
    depth += 1;
  }
  return depths;
}
