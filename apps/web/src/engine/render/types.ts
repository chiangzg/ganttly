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
