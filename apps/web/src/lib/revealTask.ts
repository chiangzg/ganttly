/**
 * Editor navigation helper (editor-interaction-optimization-plan §6.4, §2.1).
 *
 * `revealTask()` brings a task into the visible region of BOTH the left task
 * table and the right Gantt canvas. It is the single entry point shared by:
 *   - new-task creation (Toolbar / TaskTable / paste)
 *   - search / filter result selection
 *   - resource-view "open task" double-click
 *
 * Semantics (plan §2.1):
 *   - The target task's row AND its bar must end up inside the viewport.
 *   - If the task is already fully visible, the view does NOT move (no jitter).
 *   - If the task's ancestors are collapsed, they are expanded first so the
 *     row actually exists in the flattened list.
 *   - Reveal is NAVIGATION, not an edit: it writes `viewState` directly via
 *     `useProjectStore.setState` and must never push a Command onto the undo
 *     stack (plan §6.4 / §9.1).
 *
 * The pure core `computeRevealTarget()` is split out so it can be unit-tested
 * without a DOM/store.
 */
import type { GanttlyFile, Task, ViewState } from '@ganttly/schema';
import { HEADER_HEIGHT, ROW_HEIGHT, clamp, dateToPixel, pixelsPerDay } from '@/engine/layout';
import { buildTree, flattenVisible, originDateFor, type TreeNode } from '@/engine/scene';
import { useProjectStore } from '@/store/useProjectStore';
import { findActiveBaseline } from '@/lib/baseline';
import { useViewStore } from '@/store/useViewStore';

/** Horizontal padding kept on each side after a horizontal reveal, in CSS px. */
const HORIZONTAL_PADDING_PX = 24;
/**
 * Vertical padding kept above the target row after a vertical reveal, so the
 * row isn't flush against the header. Kept small so jumping to a task doesn't
 * feel like a big scroll.
 */
const VERTICAL_PADDING_PX = ROW_HEIGHT * 2;

export interface RevealViewport {
  /** Chart canvas width (CSS px) — the element with `[data-gantt-chart]`. */
  width: number;
  /** Chart canvas height (CSS px), including the header row. */
  height: number;
}

export interface RevealOptions {
  /**
   * If true (default), expand any collapsed ancestors of the target so its row
   * becomes visible in the flattened task list. Set to false when the caller
   * has already ensured visibility.
   */
  expandAncestors?: boolean;
  /**
   * If true (default), avoid moving the view when the target is already fully
   * visible — prevents jitter on repeated reveal calls.
   */
  skipIfVisible?: boolean;
}

export interface RevealTarget {
  /** New horizontal scroll, or null if the bar is already in view. */
  scrollLeft: number | null;
  /** New vertical scroll, or null if the row is already in view. */
  scrollTop: number | null;
  /** Ancestor task ids that must be un-collapsed for the row to appear. */
  ancestorsToExpand: string[];
}

/**
 * Pure core: compute the scrollLeft / scrollTop / ancestors-to-expand needed
 * to bring `taskId` into view. Returns `null` when the task does not exist.
 *
 * Uses the SAME origin the renderer uses (`originDateFor`) and the SAME row
 * index the task table uses (`flattenVisible`), so the computed scroll lines
 * up with what the user sees.
 */
export function computeRevealTarget(
  file: GanttlyFile,
  taskId: string,
  viewport: RevealViewport,
  options: RevealOptions & {
    /** Collapsed set AFTER ancestor expansion (computed internally). */
  } = {},
): RevealTarget | null {
  const { expandAncestors = true, skipIfVisible = true } = options;

  const target = file.tasks.find((t) => t.id === taskId);
  if (!target) return null;

  // 1. Determine ancestors that are currently collapsed (they hide the row).
  const collapsedSet = new Set(file.viewState.collapsedTaskIds);
  const ancestorsToExpand: string[] = [];
  if (expandAncestors) {
    // Walk parentId chain; any collapsed ancestor hides this row.
    const byId = new Map(file.tasks.map((t) => [t.id, t]));
    let cursor: Task | undefined = target;
    while (cursor && cursor.parentId) {
      const parent = byId.get(cursor.parentId);
      if (!parent) break;
      if (collapsedSet.has(parent.id)) ancestorsToExpand.push(parent.id);
      cursor = parent;
    }
  }
  // Build the effective collapsed set: remove the ancestors we will expand.
  for (const id of ancestorsToExpand) collapsedSet.delete(id);

  // 2. Find the target's global row index in the (expanded) flattened tree.
  const tree = buildTree(file.tasks);
  const visible = flattenVisible(tree, collapsedSet);
  const rowIndex = visible.findIndex((n) => n.task.id === taskId);
  if (rowIndex === -1) {
    // Even after expansion the row isn't in the flat list — nothing to scroll to.
    return { scrollLeft: null, scrollTop: null, ancestorsToExpand };
  }

  const activeBaseline = findActiveBaseline(
    file.baselines,
    useViewStore.getState().activeBaselineId,
  );
  const origin = originDateFor(file, { activeBaseline });
  const zoom = file.viewState.zoom;

  // 3. Horizontal visibility — bar span in chart-local pixels, mapped to
  //    viewport-local coords by subtracting the current scrollLeft.
  const barStartPx = dateToPixel(target.start, origin, zoom);
  const barEndPx = dateToPixel(target.end, origin, zoom) + pixelsPerDay(zoom);
  const viewLeft = file.viewState.scrollLeft;
  const barViewStart = barStartPx - viewLeft;
  const barViewEnd = barEndPx - viewLeft;

  let scrollLeft: number | null;
  if (
    skipIfVisible &&
    barViewStart >= -HORIZONTAL_PADDING_PX &&
    barViewEnd <= viewport.width + HORIZONTAL_PADDING_PX
  ) {
    // Bar fully visible (with padding) — don't move.
    scrollLeft = null;
  } else if (barViewEnd > viewport.width || barViewStart < 0) {
    // Bar outside viewport — center it, clamped to >= 0.
    const barCenter = (barStartPx + barEndPx) / 2;
    const candidate = Math.floor(barCenter - viewport.width / 2);
    scrollLeft = Math.max(0, candidate);
  } else {
    scrollLeft = null;
  }

  // 4. Vertical visibility — row top/bottom in viewport-local coords.
  const rowTop = rowIndex * ROW_HEIGHT;
  const rowBottom = rowTop + ROW_HEIGHT;
  const viewTop = file.viewState.scrollTop;
  const rowViewTop = rowTop - viewTop;
  const rowViewBottom = rowBottom - viewTop;
  const contentTop = HEADER_HEIGHT; // rows live below the header in the canvas

  let scrollTop: number | null;
  if (skipIfVisible && rowViewTop >= contentTop - 1 && rowViewBottom <= viewport.height) {
    scrollTop = null;
  } else {
    // Put the row a couple of rows below the header so context is visible.
    const candidate = Math.floor(rowTop - contentTop - VERTICAL_PADDING_PX);
    scrollTop = Math.max(0, candidate);
  }

  return { scrollLeft, scrollTop, ancestorsToExpand };
}

/**
 * Bring `taskId` into view by writing view state directly to the project
 * store (bypassing the Command/undo stack — plan §6.4). Returns true if the
 * task was found and any view change (or ancestor expansion) was applied.
 *
 * Looks up the chart viewport from the `[data-gantt-chart]` element so the
 * horizontal reveal matches the actual canvas width, mirroring `jumpToToday`
 * in the Toolbar. Falls back to a sensible default when the element isn't
 * mounted yet (e.g. during initial mount before ResizeObserver fires).
 */
export function revealTask(taskId: string, options: RevealOptions = {}): boolean {
  const file = useProjectStore.getState().file;
  const chartEl = document.querySelector('[data-gantt-chart]') as HTMLElement | null;
  const viewport: RevealViewport = {
    width: chartEl ? chartEl.clientWidth : 800,
    height: chartEl ? chartEl.clientHeight : 600,
  };

  const target = computeRevealTarget(file, taskId, viewport, options);
  if (!target) return false;

  const next: Partial<ViewState> = {};
  // Expand ancestors first (mutates collapsedTaskIds) so the row exists before
  // we scroll to it.
  if (target.ancestorsToExpand.length > 0) {
    const remove = new Set(target.ancestorsToExpand);
    next.collapsedTaskIds = file.viewState.collapsedTaskIds.filter((id) => !remove.has(id));
  }
  if (target.scrollLeft !== null) next.scrollLeft = target.scrollLeft;
  if (target.scrollTop !== null) next.scrollTop = target.scrollTop;

  if (
    next.collapsedTaskIds === undefined &&
    target.scrollLeft === null &&
    target.scrollTop === null
  ) {
    // Nothing to change — task already visible and ancestors expanded.
    return true;
  }

  // Direct setState — navigation, NOT an undoable edit (plan §6.4 / §9.1).
  useProjectStore.setState({
    file: {
      ...file,
      viewState: { ...file.viewState, ...next },
    },
  });
  return true;
}

/**
 * Clamp a row index into the scrollable range. Exported for callers that want
 * to pre-compute bounds (e.g. keyboard pgup/pgdown).
 */
export function clampScrollTop(
  scrollTop: number,
  totalRows: number,
  viewportHeight: number,
): number {
  const max = Math.max(0, totalRows * ROW_HEIGHT - viewportHeight);
  return clamp(scrollTop, 0, max);
}

/** Find the global visible row index of a task, expanding ancestors first. */
export function visibleRowIndex(file: GanttlyFile, taskId: string): number {
  const tree = buildTree(file.tasks);
  const visible = flattenVisible(tree, new Set(file.viewState.collapsedTaskIds));
  return visible.findIndex((n) => n.task.id === taskId);
}

/** Re-export for tests that build trees by hand. */
export type { TreeNode };
