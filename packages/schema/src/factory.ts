/**
 * Factory helpers for creating valid `GanttlyFile` objects.
 *
 * Used by:
 * - First-run bootstrap (creating an empty default project).
 * - Tests (constructing fixtures).
 * - The `.gan` importer (M4) to produce a fresh file before populating.
 */
import {
  SCHEMA_VERSION,
  type GanttlyFile,
  type Locale,
  type CalendarId,
  type Task,
  type ViewState,
} from './types.js';

const APP_VERSION = '0.1.0';

/**
 * The canonical neutral view state stored server-side (spec §5.2
 * `DEFAULT_REMOTE_VIEW_STATE`). The server ignores the client-submitted
 * `viewState` on import/PUT and substitutes this value, so a project's
 * revision never moves on scroll/selection changes. The web client overlays
 * its own per-device view state on top after loading.
 */
export const DEFAULT_VIEW_STATE: ViewState = {
  zoom: 'week',
  scrollLeft: 0,
  scrollTop: 0,
  selectedTaskId: null,
  showCriticalPath: false,
  collapsedTaskIds: [],
};

export interface CreateEmptyFileOptions {
  name?: string;
  locale?: Locale;
  calendarId?: CalendarId;
  appVersion?: string;
}

/**
 * Returns a minimally-valid `GanttlyFile` with empty task list and the default
 * zh-CN calendar shell (no holidays — caller fills them from `@ganttly/calendar-data`).
 */
export function createEmptyFile(options: CreateEmptyFileOptions = {}): GanttlyFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      name: options.name ?? 'Untitled project',
      locale: options.locale ?? 'zh-CN',
    },
    calendar: {
      id: options.calendarId ?? 'zh-CN',
      weekStart: 1,
      weekends: [0, 6],
      holidays: [],
      workingHours: { start: '09:00', end: '18:00' },
    },
    tasks: [],
    resources: [],
    baselines: [],
    // Fresh copy so callers can mutate the returned file without touching the
    // shared {@link DEFAULT_VIEW_STATE} template.
    viewState: {
      ...DEFAULT_VIEW_STATE,
      collapsedTaskIds: [...DEFAULT_VIEW_STATE.collapsedTaskIds],
    },
    meta: {
      createdAt: now,
      updatedAt: now,
      appVersion: options.appVersion ?? APP_VERSION,
    },
  };
}

export interface CreateDefaultTaskOptions {
  /** Task id. Caller supplies this (nanoid) so the same value is known up front
   * for selection / reveal / undo wiring. */
  id: string;
  /** Display name. Pass the localised placeholder when creating a blank task. */
  name: string;
  /** ISO date `YYYY-MM-DD` for both `start` and `end` (1-day task). */
  start: string;
  /** Parent task id, or null for a top-level task. */
  parentId: string | null;
  /** 0-based sort order among siblings. */
  order: number;
}

/**
 * Returns a minimally-valid `Task` with neutral defaults suitable for a freshly
 * created task: a 1-day span at `start`, zero progress, no dependencies,
 * constraints or assignments.
 *
 * Used by the Toolbar "new task", TaskTable "new sibling / child / root" and
 * paste flows so they all share identical initial field shape (plan §3.1).
 */
export function createDefaultTask(options: CreateDefaultTaskOptions): Task {
  return {
    id: options.id,
    name: options.name,
    parentId: options.parentId,
    order: options.order,
    start: options.start,
    end: options.start,
    duration: 1,
    overtimeDates: [],
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
  };
}
