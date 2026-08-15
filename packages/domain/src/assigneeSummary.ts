/**
 * Assignee summary derivation (editor-interaction-optimization-plan §3.3).
 *
 * A task's `assignments` array lists `{ resourceId, load }`. The Canvas bar
 * label needs a short string ("王强", "王强 +2", or muted "未分配") and the
 * task Tooltip needs the full list of `{ id, name, load }`.
 *
 * Both derivations live here as PURE functions so they can be unit-tested
 * without a DOM/store, and so `assembleScene` can call them once per row
 * without doing resource-array lookups inside the render loop (plan §3.3
 * acceptance: 1000-task scenes stay O(n)).
 */
import type { Resource, TaskAssignment } from '@ganttly/schema';

export interface Assignee {
  id: string;
  name: string;
  load: number;
}

/**
 * Resolve a task's assignments into a full assignee list, looking up each
 * resource's name from the pre-built `resourceById` map.
 *
 * Assignments whose resource has been deleted (id missing from the map) are
 * dropped — there is no name to show, and keeping a blank entry would mislead
 * the "未分配" / "+N" logic.
 */
export function resolveAssignees(
  assignments: ReadonlyArray<TaskAssignment>,
  resourceById: ReadonlyMap<string, Resource>,
): Assignee[] {
  const out: Assignee[] = [];
  for (const a of assignments) {
    const r = resourceById.get(a.resourceId);
    if (!r) continue; // resource deleted — skip silently
    out.push({ id: r.id, name: r.name, load: a.load });
  }
  return out;
}

/**
 * Build the short Canvas-label summary.
 *
 *   - 1 assignee  → that owner's name ("王强")
 *   - N assignees → primary + " +N-1" ("王强 +2")
 *   - 0 assignees → '' (the caller renders a muted "未分配")
 *
 * Order follows the task's `assignments` array (plan §9.1: first entry is the
 * primary owner).
 */
export function computeAssigneeSummary(assignees: ReadonlyArray<Assignee>): string {
  if (assignees.length === 0) return '';
  if (assignees.length === 1) return assignees[0]!.name;
  const primary = assignees[0]!.name;
  return `${primary} +${assignees.length - 1}`;
}
