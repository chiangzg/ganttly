/**
 * Defensive normalization for loaded `GanttlyFile` objects.
 *
 * Runs BEFORE AJV validation (`validateGanttlyFile`) so that older files —
 * which predate newer optional fields — pass validation. All P1 data-model
 * changes are additive (new optional fields), so normalization is the only
 * migration machinery we need: it fills in defaults for fields an old file
 * omits, leaving everything else untouched.
 *
 * Why this lives in the schema package (and takes an injected holiday
 * provider): the schema package has no dependency on `@ganttly/calendar-data`,
 * so the zh-CN holiday backfill is injected by the caller (the web app, which
 * already depends on both packages). This keeps the package dependency graph
 * acyclic and lets the schema package stay a pure leaf.
 *
 * Update cadence: when a P1 feature extends the schema (e.g. Resource.capacity,
 * TaskConstraints.type), add the default-fill for the new field here IN THE
 * SAME change set, so old files load cleanly.
 */
import type { GanttlyFile, Holiday } from './types.js';

export interface NormalizeFileOptions {
  /**
   * Returns the holiday list for a calendar region. When provided, a zh-CN file
   * whose `calendar.holidays` is empty is backfilled with the bundled dataset
   * (older exports shipped without holidays). Injected by the caller to avoid a
   * schema → calendar-data dependency.
   */
  getHolidays?: (region: string) => Holiday[];
}

/**
 * Returns a normalized copy of `file` with all optional P1 fields defaulted.
 *
 * Mutates nothing — returns a shallow-cloned top level so callers that hold
 * the original reference are unaffected. Nested objects that are modified
 * (currently only `calendar`) are cloned before mutation.
 *
 * Safe to call on a freshly `createEmptyFile()` result (no-op) and on a file
 * that has already been normalized (idempotent).
 */
export function normalizeFile(file: GanttlyFile, options: NormalizeFileOptions = {}): GanttlyFile {
  // Shallow clone so we never mutate the caller's object.
  const next: GanttlyFile = { ...file };

  // ---- calendar ------------------------------------------------------------
  // Backfill zh-CN holidays for older exports that shipped an empty list.
  // (Absorbed from ImportMenu.tsx's former inline patch.)
  if (options.getHolidays && next.calendar.holidays.length === 0 && next.calendar.id === 'zh-CN') {
    next.calendar = {
      ...next.calendar,
      holidays: options.getHolidays('zh-CN'),
    };
  }

  // ---- resources -----------------------------------------------------------
  // P1 Resource.capacity defaults to 1.0 (full-time). Old files (or resources
  // created before the field existed) omit it; person-day math treats a missing
  // capacity as 1.0, so we materialize the default here for consistency.
  if (next.resources.length > 0) {
    let mutated = false;
    const resources = next.resources.map((r) =>
      r.capacity === undefined ? ((mutated = true), { ...r, capacity: 1.0 }) : r,
    );
    if (mutated) next.resources = resources;
  }

  // ---- task constraints ----------------------------------------------------
  // P1 TaskConstraints is now `{ type: ConstraintType; date?: string }`. Old
  // MVP files wrote `constraints: {}` (empty record) — which fails the new
  // `required: ["type"]`. Normalize empty/missing type to 'none'.
  if (next.tasks.length > 0) {
    let mutated = false;
    const tasks = next.tasks.map((t) => {
      if (!t.constraints || typeof t.constraints !== 'object' || t.constraints.type === undefined) {
        mutated = true;
        return { ...t, constraints: { type: 'none' as const } };
      }
      return t;
    });
    if (mutated) next.tasks = tasks;
  }

  return next;
}
