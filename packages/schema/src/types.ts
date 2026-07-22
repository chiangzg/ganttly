/**
 * ganttly data model — TypeScript types.
 *
 * Mirrors PRD §4.1 (data model). The companion `schema.json` is the
 * machine-checkable JSON Schema (draft 2020-12) and is the single source of
 * truth for external tooling; this file is the source of truth for the
 * TypeScript runtime.
 *
 * Design notes (see PRD §4.2):
 * - Tasks are FLAT (parentId + order), not nested. UI assembles them into a
 *   tree at render time. Drag-to-reparent is O(1) field updates, not a
 *   subtree rewrite.
 * - `calendar` is a first-class top-level object, because holiday data must
 *   be independently updatable (PRD pain point B).
 * - `schemaVersion` is explicit so we can ship `migrate()` functions across
 *   breaking schema changes.
 */

// ---------------------------------------------------------------------------
// Top-level file
// ---------------------------------------------------------------------------

/** Current schema version. Bump on breaking data-model changes. */
export const SCHEMA_VERSION = 1 as const;

/** A complete ganttly project file (the unit persisted to IndexedDB / JSON). */
export interface GanttlyFile {
  schemaVersion: typeof SCHEMA_VERSION;
  project: Project;
  calendar: Calendar;
  /** Flat array of tasks. UI assembles into a tree via `parentId`. */
  tasks: Task[];
  /** P1 reserved. MVP always emits `[]`. */
  resources: Resource[];
  /** P1 reserved. MVP always emits `[]`. */
  baselines: Baseline[];
  viewState: ViewState;
  meta: FileMeta;
}

export interface FileMeta {
  /** ISO 8601 datetime, e.g. `2026-07-21T10:00:00.000Z`. */
  createdAt: string;
  /** ISO 8601 datetime. */
  updatedAt: string;
  /** ganttly semver that produced this file, e.g. `0.1.0`. */
  appVersion: string;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface Project {
  name: string;
  company?: string;
  manager?: string;
  /** ISO date `YYYY-MM-DD`. Reference only — does not constrain tasks. */
  startDate?: string;
  locale: Locale;
  /** IANA timezone, e.g. `Asia/Shanghai`. */
  timezone?: string;
}

export type Locale = 'zh-CN' | 'en';

// ---------------------------------------------------------------------------
// Calendar (first-class — PRD §2.5 / §4.2.2)
// ---------------------------------------------------------------------------

export interface Calendar {
  /** Calendar region id. MVP only supports `zh-CN`. */
  id: CalendarId;
  /** 0 = Sunday, 1 = Monday. China convention is 1. */
  weekStart: 0 | 1;
  /** Days of week that are non-working by default. 0=Sun ... 6=Sat. */
  weekends: number[];
  /** Public holidays AND make-up working days (调休). */
  holidays: Holiday[];
  workingHours: WorkingHours;
}

export type CalendarId = 'zh-CN' | (string & {});

export interface Holiday {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Display name, e.g. `元旦`, `春节`. */
  name: string;
  /**
   * - `holiday`: non-working day (highlighted on the grid).
   * - `working`: make-up working day (调休补班, NOT highlighted, counts as a
   *   working day in duration math).
   */
  type: 'holiday' | 'working';
}

export interface WorkingHours {
  start: string; // `HH:mm`, e.g. `09:00`
  end: string; // `HH:mm`, e.g. `18:00`
}

// ---------------------------------------------------------------------------
// Task (flat — PRD §4.2.1)
// ---------------------------------------------------------------------------

export interface Task {
  /** UUID v4 or nanoid. Primary key. */
  id: string;
  name: string;
  /** Parent task id, or null for top-level tasks. */
  parentId: string | null;
  /** Sort order among siblings (0-based). */
  order: number;
  /** ISO date `YYYY-MM-DD`. */
  start: string;
  /** ISO date `YYYY-MM-DD`. Inclusive end date of the last working day. */
  end: string;
  /** Duration in WORKING days (excludes holidays/weekends, includes 调休). */
  duration: number;
  /** 0-100 inclusive. */
  progress: number;
  isMilestone: boolean;
  /** CSS color. Optional — engine provides a default. */
  color?: string;
  /** Markdown note. */
  note?: string;
  dependencies: Dependency[];
  /** P1 reserved. MVP emits `{}`. */
  constraints: TaskConstraints;
  /** P1 reserved. MVP emits `[]`. */
  assignments: TaskAssignment[];
  /** P1 reserved. MVP emits `{}`. */
  customFields: Record<string, unknown>;
}

export interface Dependency {
  /**
   * Id of the PREDECESSOR task (the one this task depends on).
   * Naming follows MS Project / GanttProject convention.
   */
  targetId: string;
  type: DependencyType;
  /** Lag in WORKING days. May be negative (lead). */
  lag: number;
}

export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';

/**
 * Task scheduling constraints (P1 feature three — G3).
 *
 * Five practical subset covering ~95% of needs (none of them require deep CPM
 * backward-pass coupling like ALAP):
 *  - `none`: no constraint (default)
 *  - `startNoEarlierThan` (SNET): start ≥ date
 *  - `mustStartOn` (MSO): start == date (hard anchor)
 *  - `mustFinishOn` (MFO): end == date (hard anchor)
 *  - `finishNoLaterThan` (FNLT): end ≤ date
 *
 * `date` is required when `type !== 'none'`. Old files (MVP) wrote `{}`; the
 * loader normalizes that to `{ type: 'none' }`.
 */
export type ConstraintType =
  'none' | 'startNoEarlierThan' | 'mustStartOn' | 'mustFinishOn' | 'finishNoLaterThan';

export interface TaskConstraints {
  type: ConstraintType;
  /** ISO date `YYYY-MM-DD`. Required when `type !== 'none'`. */
  date?: string;
}

/** P1 reserved — empty in MVP. */
export interface TaskAssignment {
  resourceId: string;
  load: number; // 0-100, percent allocation
}

// ---------------------------------------------------------------------------
// Resources (P1 reserved)
// ---------------------------------------------------------------------------

export interface Resource {
  id: string;
  name: string;
  /**
   * Hourly cost rate. Deprecated in P1: the cost feature was scoped down to
   * person-days only (grilling Q7), so `rate` is retained for schema
   * compatibility but is not read by any P1 computation or UI. It remains so
   * older v0.1.0 files with `rate` still load (additive-only policy).
   */
  rate?: number;
  /** Capacity 0-1, default 1.0 (full-time). Drives load-chart overload detection. P1. */
  capacity?: number;
  /** Role label for filtering, e.g. "前端", "设计". P1. */
  role?: string;
  /** CSS color for distinguishing resources on the load chart. P1. */
  color?: string;
}

// ---------------------------------------------------------------------------
// Baselines (P1 reserved)
// ---------------------------------------------------------------------------

export interface Baseline {
  id: string;
  name: string;
  capturedAt: string; // ISO datetime
  tasks: BaselineTask[];
}

export interface BaselineTask {
  id: string;
  start: string;
  end: string;
  duration: number;
  progress: number;
}

// ---------------------------------------------------------------------------
// View state (persisted across sessions)
// ---------------------------------------------------------------------------

export interface ViewState {
  zoom: ZoomLevel;
  scrollLeft: number;
  scrollTop: number;
  selectedTaskId: string | null;
  showCriticalPath: boolean;
  collapsedTaskIds: string[];
}

export type ZoomLevel = 'day' | 'week' | 'month' | 'year';
