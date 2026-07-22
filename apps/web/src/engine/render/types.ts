/**
 * Shared types for the Canvas renderer.
 *
 * The renderer is structured as: scene → render functions → Canvas2D
 * commands. The scene is an immutable snapshot of what to draw; render
 * functions are pure (they take a CanvasRenderingContext2D and a scene, and
 * draw without external state).
 *
 * Colors come from CSS custom properties (see styles/index.css) so dark mode
 * works automatically. The host component resolves them to RGB strings
 * before passing to the renderer (Canvas cannot read CSS vars directly).
 */
import type { ZoomLevel, Holiday } from '@ganttly/schema';

/** Resolved theme colors — CSS-variable values converted to rgb() strings. */
export interface ThemeColors {
  bg: string;
  bgElevated: string;
  border: string;
  fg: string;
  fgMuted: string;
  primary: string;
  accent: string;
  danger: string;
  nonWorking: string;
  warning: string;
  taskBar: string;
  taskProgress: string;
  critical: string;
  todayLine: string;
}

/** A single task row in the rendered scene. */
export interface TaskRow {
  id: string;
  name: string;
  start: string; // ISO date
  end: string; // ISO date
  progress: number; // 0-100
  isMilestone: boolean;
  color?: string;
  depth: number;
  wbsNumber: string;
  isCritical?: boolean;
  isSummary?: boolean;
  /** Scheduling constraint (P1 feature three). Present when type !== 'none'. */
  constraint?: { type: string; date: string };
  /** True when this task's constraint conflicts with its dependencies (G4). */
  hasConstraintConflict?: boolean;
}

/** A dependency arrow in the rendered scene. */
export interface ArrowSpec {
  fromId: string;
  toId: string;
  type: 'FS' | 'SS' | 'FF' | 'SF';
  /** Origin pixel of the arrow's tail (chart-local). */
  fromX: number;
  fromY: number;
  /** End pixel of the arrow's head (chart-local). */
  toX: number;
  toY: number;
  isCritical?: boolean;
  /** True when the successor's constraint conflicts with this dependency (G4). */
  isConflict?: boolean;
}

/** A single load bar for one resource on one date (P1 feature one). */
export interface ResourceLoadBar {
  resourceId: string;
  /** ISO date this bar covers (one working day). */
  date: string;
  /** Total load 0-100+ for this resource on this date (>100 = overload). */
  load: number;
}

/**
 * Rows in the resource-view scene (P1 feature one, G7).
 *
 * The flattened row list mixes three kinds of rows so the left list and the
 * right canvas can align pixel-for-pixel when a resource is drilled down:
 * - A `resource` row: the resource itself, with its per-day load bars.
 * - A `task-header` row: the local header for task lanes beneath an expanded
 *   resource (drawn by the left pane; the chart side stays empty).
 * - A `task` row (only present when the resource is expanded): one lane per
 *   leaf task mounted on the resource, used to draw the task's load bar.
 *
 * Each row carries a global `yIndex` (its 0-based position in the flattened
 * list) so the renderer positions it with `HEADER_HEIGHT + yIndex * ROW_HEIGHT`
 * exactly like the left list, and both panes share the same total height.
 */
export interface ResourceRowBase {
  /** Global 0-based index of this row in the flattened scene rows. */
  yIndex: number;
}

/** A resource summary row (the resource itself). */
export interface ResourceSummaryRow extends ResourceRowBase {
  kind: 'resource';
  id: string;
  name: string;
  role?: string;
  /** Capacity 0-1, default 1.0. Drives the 100% threshold line. */
  capacity: number;
  /** Load bars for this resource (one per working day with any load). */
  bars: ResourceLoadBar[];
  /** Whether this resource is currently expanded (drilled down). */
  expanded: boolean;
  /** Leaf tasks mounted on this resource (for the expand-arrow visibility). */
  taskCount: number;
}

/** A local task-column header row shown inside an expanded resource group. */
export interface ResourceTaskHeaderRow extends ResourceRowBase {
  kind: 'task-header';
  resourceId: string;
}

/** A task lane row, shown beneath its resource when expanded. */
export interface ResourceTaskRow extends ResourceRowBase {
  kind: 'task';
  taskId: string;
  /** The resource this lane belongs to (for selection highlight scoping). */
  resourceId: string;
  name: string;
  /** WBS number (e.g. `1.2.3`) for display. */
  wbsNumber: string;
  start: string; // ISO date
  end: string; // ISO date (inclusive)
  duration: number; // working days
  progress: number; // 0-100
  isMilestone: boolean;
  /** This resource's load on this task, from the assignment (0-100). */
  load: number;
  /** Inherited from the owning resource; drives the overload color threshold. */
  capacity: number;
}

export type ResourceRow = ResourceSummaryRow | ResourceTaskHeaderRow | ResourceTaskRow;

/** The complete immutable scene for the resource (load) view. */
export interface ResourceScene {
  zoom: ZoomLevel;
  originDate: string;
  scrollLeft: number;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  today: string;
  holidays: Holiday[];
  /** Flattened rows in display order (resources + expanded task lanes). */
  rows: ResourceRow[];
  selectedResourceId: string | null;
  /** Selected drilled-down task lane (G19: independent of selectedTaskId). */
  selectedTaskIdInResource: string | null;
}

/** The complete immutable scene passed to render functions. */
export interface Scene {
  zoom: ZoomLevel;
  originDate: string; // ISO date at pixel 0
  /** Top-left of the visible viewport, in chart-local pixels. */
  scrollLeft: number;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Today's date (ISO). Used to draw the Today line. */
  today: string;
  /** Holidays to highlight in the visible range. */
  holidays: Holiday[];
  /** Visible task rows in row-order (already flattened + filtered). */
  rows: TaskRow[];
  /** Dependency arrows. */
  arrows: ArrowSpec[];
  /** Whether to highlight the critical path. */
  showCriticalPath: boolean;
  /** Currently selected task id (draws a focus ring). */
  selectedTaskId: string | null;
}

/** The full render options. */
export interface RenderOptions {
  theme: ThemeColors;
  /** Pixel ratio to multiply by (devicePixelRatio) for crisp Retina rendering. */
  dpr: number;
  /** Show column for non-working days (holidays/weekends)? */
  highlightNonWorking: boolean;
}
