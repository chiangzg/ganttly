/**
 * Multi-select selection model (editor-interaction-optimization-plan §4.6).
 *
 * Pure core that computes the next selection set from a pointer-down event,
 * given the modifier keys (Ctrl/Cmd = toggle, Shift = range) and the current
 * selection. Kept store/DOM-free so it can be unit-tested directly and shared
 * by both the left TaskTable rows and the right GanttCanvas bars (plan §4.6:
 * "Canvas 与任务表共享 selection set").
 *
 * Selection is NAVIGATION/ephemeral (plan §9.1: "导航、选择、hover、拖拽预览
 * 和筛选不进入 undo 栈") — callers write the result to `useViewStore`, never
 * via the undo-stack dispatch path.
 */

/** The current selection state consumed by the pure core. */
export interface SelectionState {
  /** Set of currently-selected task ids (size 1 when single-selecting). */
  ids: ReadonlySet<string>;
  /** Anchor id — the Shift-range start and the "primary" selection (drawer). */
  anchor: string | null;
}

/** Modifier flags from the pointer/keyboard event. */
export interface PointerModifiers {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/**
 * Compute the selection resulting from a pointer-down on `taskId`.
 *
 * Semantics (plan §4.6):
 *   - No modifier  → single-select `taskId` (replaces selection), anchor = taskId.
 *   - Ctrl/Cmd     → toggle `taskId` in the set. Removing the anchor degrades
 *                    it to an arbitrary remaining id (or null when emptied);
 *                    adding keeps the existing anchor so Shift still works.
 *   - Shift        → select the contiguous range from `anchor` to `taskId`
 *                    within `visibleIds` (the currently-rendered row sequence,
 *                    so the range respects collapse/filter — plan §4.6 验收
 *                    "多选在折叠、筛选和滚动后保持一致"). Anchor is unchanged.
 *                    With no anchor, Shift degrades to a single-select.
 *
 * `visibleIds` is only consulted for Shift-range; pass the current rendered
 * row id sequence (post-collapse, post-filter).
 */
export function computeSelectionOnPointerDown(
  taskId: string,
  mods: PointerModifiers,
  current: SelectionState,
  visibleIds: ReadonlyArray<string>,
): SelectionState {
  // Shift takes priority over Ctrl/Cmd for range selection (matches common
  // file-explorer / spreadsheet behaviour).
  if (mods.shift) {
    if (current.anchor === null) {
      return { ids: new Set([taskId]), anchor: taskId };
    }
    const range = rangeBetween(current.anchor, taskId, visibleIds);
    // Range replaces the selection but keeps the anchor (so a subsequent
    // Shift+Click still extends from the same origin).
    return { ids: range, anchor: current.anchor };
  }

  if (mods.ctrl || mods.meta) {
    const next = new Set(current.ids);
    if (next.has(taskId)) {
      next.delete(taskId);
      // Removing the anchor: fall back to another selected id, else null.
      const anchor =
        current.anchor === taskId ? (next.values().next().value ?? null) : current.anchor;
      return { ids: next, anchor };
    }
    next.add(taskId);
    // Keep the existing anchor so Shift-range origin is stable while toggling.
    return { ids: next, anchor: current.anchor ?? taskId };
  }

  // Plain click: single-select, replacing any multi-selection.
  return { ids: new Set([taskId]), anchor: taskId };
}

/**
 * Return the inclusive contiguous id set between `from` and `to` within
 * `visibleIds`. If either endpoint is absent from the sequence, returns just
 * the two endpoints (best-effort — should not normally happen since both are
 * visible rows). Order-independent: `rangeBetween(a, b, …) === rangeBetween(b, a, …)`.
 */
function rangeBetween(from: string, to: string, visibleIds: ReadonlyArray<string>): Set<string> {
  if (from === to) return new Set([from]);
  const fromIdx = visibleIds.indexOf(from);
  const toIdx = visibleIds.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) {
    // Endpoint not in the visible list — return the two ids as a fallback.
    return new Set([from, to]);
  }
  const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
  const out = new Set<string>();
  for (let i = lo; i <= hi; i++) {
    const id = visibleIds[i];
    if (id !== undefined) out.add(id);
  }
  return out;
}
