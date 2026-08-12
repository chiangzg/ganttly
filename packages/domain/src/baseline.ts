/**
 * Baseline comparison — pure functions (baseline-comparison spec §3, §6.2).
 *
 * This module is the single source of truth for deviation math. Every display
 * surface (Canvas, TaskTable, TaskDrawer, StatusBar) MUST consume these
 * functions so the deviation values stay consistent.
 *
 * Conventions:
 * - Deviations are SIGNED WORKING-DAY deltas (positive = later/longer).
 * - Working-day math reuses {@link isWorkingDay} so weekends, statutory
 *   holidays and 调休补班 are all honoured automatically.
 * - Task `overtimeDates` are NEVER part of the date-deviation calendar: they
 *   are a task-effort rule, not a project-calendar rule.
 * - Summary tasks use freshly recomputed rollup values (captured at snapshot
 *   time), never the possibly-stale `Task.start/end/duration`.
 * - All functions are O(n) over tasks; no nested `baseline.tasks.find()`.
 */
import type { GanttlyFile, Baseline, BaselineTask, Task } from '@ganttly/schema';
import type { ResolvedCalendar } from './calendar';
import { isWorkingDay, addCalendarDays, resolveCalendar } from './calendar';
import { computeAllRollups, type RollupResult } from './summary';

// ---------------------------------------------------------------------------
// Variance types (spec §3.1 — discriminated union recommended)
// ---------------------------------------------------------------------------

/**
 * Deviation result for a single task vs. the active baseline.
 *
 * Use the discriminated union so callers cannot accidentally read numeric
 * deltas for an "added" task (which has no baseline to compare against).
 */
export type TaskBaselineVariance =
  | {
      status: 'on-track' | 'early' | 'late';
      taskId: string;
      /** Signed working-day delta (current − baseline). Positive = later. */
      startDelta: number;
      /** Signed working-day delta (current − baseline). Positive = later. */
      finishDelta: number;
      /** Working-day delta (current − baseline). Positive = longer. */
      durationDelta: number;
    }
  | { status: 'added'; taskId: string };

// ---------------------------------------------------------------------------
// Snapshot capture
// ---------------------------------------------------------------------------

/**
 * Capture an immutable snapshot of every task's current effective dates.
 *
 * Summary tasks use freshly recomputed rollup values (`computeAllRollups`)
 * rather than their possibly-stale `start/end/duration` fields — so a summary
 * captured mid-drag still records the true aggregated span (spec §2.3).
 *
 * The returned `Baseline.tasks` are brand-new objects; the input file is not
 * mutated and no task references are retained.
 */
export function createBaselineSnapshot(
  file: GanttlyFile,
  input: { id: string; name: string; capturedAt: string },
): Baseline {
  const cal = resolveCal(file);
  const rollups = computeAllRollups(file.tasks, file.resources, cal);
  // Summary-task id set so we know which tasks to read rollup values for.
  const summaryIds = buildSummaryIds(file.tasks);

  const tasks: BaselineTask[] = file.tasks.map((t) => {
    if (summaryIds.has(t.id)) {
      const r = rollups.get(t.id);
      if (r) {
        return { id: t.id, start: r.start, end: r.end, duration: r.duration, progress: r.progress };
      }
    }
    return { id: t.id, start: t.start, end: t.end, duration: t.duration, progress: t.progress };
  });

  return { id: input.id, name: input.name, capturedAt: input.capturedAt, tasks };
}

// ---------------------------------------------------------------------------
// Signed working-day delta (spec §3.2)
// ---------------------------------------------------------------------------

/**
 * Signed working-day delta from `baselineDate` to `currentDate`.
 *
 * - Equal dates → `0`.
 * - `currentDate` later → count working days in `(baselineDate, currentDate]`,
 *   return positive.
 * - `currentDate` earlier → count working days in `(currentDate, baselineDate]`,
 *   return negative.
 * - Two distinct non-working days that straddle no working day → `0`.
 *
 * `isWorkingDay()` already encodes weekends + statutory holidays + 调休, so no
 * special-casing is needed here.
 */
export function signedWorkingDayDelta(
  baselineDate: string,
  currentDate: string,
  cal: ResolvedCalendar,
): number {
  if (currentDate === baselineDate) return 0;
  if (currentDate > baselineDate) {
    return countWorkingDaysExclusive(baselineDate, currentDate, cal);
  }
  return -countWorkingDaysExclusive(currentDate, baselineDate, cal);
}

/**
 * Count working days in the half-open interval `(fromExclusive, toInclusive]`.
 * `fromExclusive` itself is never counted; `toInclusive` is.
 */
function countWorkingDaysExclusive(
  fromExclusive: string,
  toInclusive: string,
  cal: ResolvedCalendar,
): number {
  let cursor = addCalendarDays(fromExclusive, 1);
  let count = 0;
  // Hard cap guards against pathological calendar definitions.
  for (let i = 0; i < 10_000 && cursor <= toInclusive; i++) {
    if (isWorkingDay(cursor, cal)) count++;
    cursor = addCalendarDays(cursor, 1);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Single-task comparison (spec §3.1)
// ---------------------------------------------------------------------------

/**
 * Compare a current task against its baseline snapshot.
 *
 * - No baseline record → `{ status: 'added', taskId }`.
 * - Else compute start/finish/duration deltas and derive status:
 *   `late` (finishDelta > 0), `early` (finishDelta < 0), `on-track` (== 0).
 *
 * Status is decided by the FINISH delta only (spec §3.3): a task whose start
 * or duration changed but whose finish is unchanged is still `on-track`. The
 * numeric start/duration deltas are still returned for detailed display.
 */
export function compareTaskToBaseline(
  current: Pick<Task, 'id' | 'start' | 'end' | 'duration'>,
  baseline: BaselineTask | undefined,
  cal: ResolvedCalendar,
): TaskBaselineVariance {
  if (!baseline) return { status: 'added', taskId: current.id };

  const startDelta = signedWorkingDayDelta(baseline.start, current.start, cal);
  const finishDelta = signedWorkingDayDelta(baseline.end, current.end, cal);
  const durationDelta = current.duration - baseline.duration;

  let status: 'on-track' | 'early' | 'late';
  if (finishDelta > 0) status = 'late';
  else if (finishDelta < 0) status = 'early';
  else status = 'on-track';

  return { status, taskId: current.id, startDelta, finishDelta, durationDelta };
}

// ---------------------------------------------------------------------------
// Project-level summary (spec §3.3)
// ---------------------------------------------------------------------------

export interface BaselineVarianceSummary {
  /** Matched LEAF tasks (current tasks that exist in the baseline). */
  matchedLeafCount: number;
  onTrackLeafCount: number;
  earlyLeafCount: number;
  lateLeafCount: number;
  /** Current LEAF tasks with no baseline record. */
  addedLeafCount: number;
  /** Baseline tasks whose id no longer exists in the current project. */
  deletedTaskCount: number;
  /** Largest positive finishDelta across leaf tasks; 0 if none late. */
  maxFinishDelay: number;
}

/**
 * Build the project-level deviation summary.
 *
 * - Only CURRENT LEAF tasks are counted for matched/on-track/early/late/added
 *   so summary tasks don't double-count their children (spec §2.5).
 * - "Deleted" counts all unmatched baseline records (we can't reliably tell
 *   whether a deleted baseline task was itself a summary, since `BaselineTask`
 *   carries no `parentId` — spec §2.5).
 * - Builds current-id Set, leaf-id Set and baseline Map ONCE → O(n). Never
 *   call `baseline.tasks.find()` inside the task loop.
 *
 * The `currentValues` map (effective start/end/duration per task, with summary
 * rollups applied) is derived from `file` here so callers don't each rebuild it.
 */
export function summarizeBaselineVariance(
  file: GanttlyFile,
  baseline: Baseline,
  cal: ResolvedCalendar,
): BaselineVarianceSummary {
  const summaryIds = buildSummaryIds(file.tasks);
  const baselineById = new Map<string, BaselineTask>();
  for (const bt of baseline.tasks) baselineById.set(bt.id, bt);

  // Effective current values: summary tasks use live rollup, leaves use self.
  const rollups = computeAllRollups(file.tasks, file.resources, cal);

  const currentIds = new Set<string>();
  let matchedLeafCount = 0;
  let onTrackLeafCount = 0;
  let earlyLeafCount = 0;
  let lateLeafCount = 0;
  let addedLeafCount = 0;
  let maxFinishDelay = 0;

  for (const t of file.tasks) {
    currentIds.add(t.id);
    if (summaryIds.has(t.id)) continue; // only leaves

    const r = rollups.get(t.id);
    const eff = r
      ? { id: t.id, start: r.start, end: r.end, duration: r.duration }
      : { id: t.id, start: t.start, end: t.end, duration: t.duration };

    const bt = baselineById.get(t.id);
    if (!bt) {
      addedLeafCount++;
      continue;
    }
    matchedLeafCount++;

    const finishDelta = signedWorkingDayDelta(bt.end, eff.end, cal);
    if (finishDelta > 0) {
      lateLeafCount++;
      if (finishDelta > maxFinishDelay) maxFinishDelay = finishDelta;
    } else if (finishDelta < 0) {
      earlyLeafCount++;
    } else {
      onTrackLeafCount++;
    }
  }

  // Deleted = baseline records whose id is gone from the current project.
  let deletedTaskCount = 0;
  for (const bt of baseline.tasks) {
    if (!currentIds.has(bt.id)) deletedTaskCount++;
  }

  return {
    matchedLeafCount,
    onTrackLeafCount,
    earlyLeafCount,
    lateLeafCount,
    addedLeafCount,
    deletedTaskCount,
    maxFinishDelay,
  };
}

// ---------------------------------------------------------------------------
// Active-baseline lookup
// ---------------------------------------------------------------------------

/** Find the active baseline by id; returns `null` when id is null or stale. */
export function findActiveBaseline(
  baselines: ReadonlyArray<Baseline>,
  activeId: string | null,
): Baseline | null {
  if (!activeId) return null;
  return baselines.find((b) => b.id === activeId) ?? null;
}

// ---------------------------------------------------------------------------
// Effective-value helpers (shared by Scene / TaskTable / Drawer)
// ---------------------------------------------------------------------------

/**
 * Effective current values for a task: summary tasks use live rollup, leaves
 * use their own fields. Avoids each display surface re-deriving summary logic.
 */
export interface EffectiveTaskValue {
  id: string;
  start: string;
  end: string;
  duration: number;
}

/**
 * Build a `Map<taskId, EffectiveTaskValue>` once, applying live rollups to
 * summary tasks. Callers (Scene, TaskTable, Drawer) should reuse a single map
 * rather than re-rolling-up per row.
 */
export function buildEffectiveValues(
  file: GanttlyFile,
  cal: ResolvedCalendar,
  rollups: ReadonlyMap<string, RollupResult> = computeAllRollups(file.tasks, file.resources, cal),
): Map<string, EffectiveTaskValue> {
  const summaryIds = buildSummaryIds(file.tasks);
  const out = new Map<string, EffectiveTaskValue>();
  for (const t of file.tasks) {
    const r = summaryIds.has(t.id) ? rollups.get(t.id) : undefined;
    out.set(t.id, {
      id: t.id,
      start: r ? r.start : t.start,
      end: r ? r.end : t.end,
      duration: r ? r.duration : t.duration,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildSummaryIds(tasks: ReadonlyArray<Task>): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.parentId) ids.add(t.parentId);
  }
  return ids;
}

function resolveCal(file: GanttlyFile): ResolvedCalendar {
  return resolveCalendar(file.calendar);
}

// Re-exported so tests can reach RollupResult typing if needed.
export type { RollupResult };
