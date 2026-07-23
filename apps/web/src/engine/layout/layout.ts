/**
 * Date↔pixel layout primitives (PRD §5.2, M1.7).
 *
 * All functions are pure — same inputs always produce same outputs. Layout
 * depends on the active `ZoomLevel` (which determines column width and how
 * many columns per day) and the horizontal scroll offset.
 *
 * Convention: pixel coordinates are CHART-LOCAL (relative to the chart's
 * canvas origin at scrollLeft=0). The renderer adds `scrollLeft` to convert
 * to viewport coordinates.
 */
import type { ZoomLevel } from '@ganttly/schema';
import { addCalendarDays, fromISODate, toISODate } from '@/lib/calendar';

/** Default column width (CSS px) for each zoom level. Tunable via UI in M3. */
export const COLUMN_WIDTH: Record<ZoomLevel, number> = {
  day: 32,
  week: 140,
  month: 120,
  year: 80,
};

/** Default row height (CSS px) for a single task row. */
export const ROW_HEIGHT = 32;

/** Header has two stacked rows (e.g. month + week). */
export const HEADER_HEIGHT = 56;

/**
 * Number of calendar days represented by ONE column at this zoom level.
 * - day: 1 column = 1 day
 * - week: 1 column = 7 days
 * - month: 1 column = ~30 days (we treat as 30 for pixel math; boundaries
 *   are aligned to actual month starts when rendering the header)
 * - year: 1 column = 1 month (12 columns per year)
 */
export const DAYS_PER_COLUMN: Record<ZoomLevel, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 30, // 12 columns per year, each ~30 days; we align by year/month below
};

/** Returns the pixel width of one day at this zoom level. */
export function pixelsPerDay(zoom: ZoomLevel): number {
  return COLUMN_WIDTH[zoom] / DAYS_PER_COLUMN[zoom];
}

/**
 * Convert an ISO date string to a chart-local X pixel (left edge of that day).
 *
 * Anchored at `originDate`'s left edge = pixel 0. Days before origin produce
 * negative pixels (the chart scrolls left to reveal them).
 */
export function dateToPixel(isoDate: string, originDate: string, zoom: ZoomLevel): number {
  const dayDelta = dayDiff(originDate, isoDate);
  return dayDelta * pixelsPerDay(zoom);
}

/** Inverse of `dateToPixel`: returns the ISO date at a chart-local X pixel. */
export function pixelToDate(pixelX: number, originDate: string, zoom: ZoomLevel): string {
  const dayDelta = Math.floor(pixelX / pixelsPerDay(zoom));
  return addCalendarDays(originDate, dayDelta);
}

/** Pixel width spanned by `[startISO, endISO]` inclusive at this zoom. */
export function dateRangeWidth(startISO: string, endISO: string, zoom: ZoomLevel): number {
  const days = dayDiff(startISO, endISO) + 1; // inclusive
  return days * pixelsPerDay(zoom);
}

/** Whole-day delta (end - start), can be negative. Inclusive end semantics caller-side. */
export function dayDiff(startISO: string, endISO: string): number {
  const a = fromISODate(startISO);
  const b = fromISODate(endISO);
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

/**
 * Returns the visible date window `[startISO, endISO]` given viewport width
 * and scrollLeft. Used for virtualisation (only render columns in view).
 */
export function visibleDateRange(
  scrollLeft: number,
  viewportWidth: number,
  originDate: string,
  zoom: ZoomLevel,
  paddingDays = 7,
): { start: string; end: string } {
  const startPx = scrollLeft - paddingDays * pixelsPerDay(zoom);
  const endPx = scrollLeft + viewportWidth + paddingDays * pixelsPerDay(zoom);
  const start = addCalendarDays(originDate, Math.floor(startPx / pixelsPerDay(zoom)));
  const end = addCalendarDays(originDate, Math.ceil(endPx / pixelsPerDay(zoom)));
  return { start, end };
}

/** Generate a list of ISO dates in `[startISO, endISO]` (inclusive). */
export function* iterateDates(startISO: string, endISO: string): Generator<string> {
  const total = dayDiff(startISO, endISO);
  for (let i = 0; i <= total; i++) {
    yield addCalendarDays(startISO, i);
  }
}

/**
 * Compute the chart's full date extent from a set of tasks. Used to size the
 * canvas horizontally and to default the origin date for a fresh project.
 */
export function computeDateExtent(
  taskDates: Array<{ start: string; end: string }>,
  fallbackStart: string,
  paddingDays = 14,
): { start: string; end: string } {
  if (taskDates.length === 0) {
    return {
      start: addCalendarDays(fallbackStart, -paddingDays),
      end: addCalendarDays(fallbackStart, paddingDays),
    };
  }
  let min = taskDates[0]!.start;
  let max = taskDates[0]!.end;
  for (const t of taskDates) {
    if (t.start < min) min = t.start;
    if (t.end > max) max = t.end;
  }
  return {
    start: addCalendarDays(min, -paddingDays),
    end: addCalendarDays(max, paddingDays),
  };
}

/** Format today's date as ISO. Exported for testability & mocking. */
export function todayISO(now: Date = new Date()): string {
  return toISODate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

/** Clamp `v` into `[lo, hi]`. Used to bound scrollTop to the real content range. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
