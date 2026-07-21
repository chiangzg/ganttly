/**
 * Factory helpers for creating valid `GanttlyFile` objects.
 *
 * Used by:
 * - First-run bootstrap (creating an empty default project).
 * - Tests (constructing fixtures).
 * - The `.gan` importer (M4) to produce a fresh file before populating.
 */
import { SCHEMA_VERSION, type GanttlyFile, type Locale, type CalendarId } from './types.js';

const APP_VERSION = '0.1.0';

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
    viewState: {
      zoom: 'week',
      scrollLeft: 0,
      scrollTop: 0,
      selectedTaskId: null,
      showCriticalPath: false,
      collapsedTaskIds: [],
    },
    meta: {
      createdAt: now,
      updatedAt: now,
      appVersion: options.appVersion ?? APP_VERSION,
    },
  };
}
