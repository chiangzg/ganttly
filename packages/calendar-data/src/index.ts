/**
 * @ganttly/calendar-data — bundled holiday datasets.
 *
 * Each region is a JSON file under `calendars/`. To add a new region, drop a
 * `<region>.json` file in `calendars/` and register it in `CALENDAR_FILES`
 * below. The dataset shape is `CalendarData` (an extension of `Calendar` from
 * `@ganttly/schema` that adds a human-readable `name` and provenance fields).
 *
 * Update cadence: PRD §2.6 — holidays ship in-repo. Each November (when China's
 * State Council releases next-year arrangements) a maintainer updates
 * `calendars/zh-CN.json`. A P1 "pull from cloud" option will supplement, not
 * replace, this dataset.
 */
import zhCN from '../calendars/zh-CN.json' with { type: 'json' };
import type { Calendar, WorkingHours } from '@ganttly/schema';

/** Calendar dataset shape on disk (slightly richer than the runtime `Calendar`). */
export interface CalendarData {
  id: string;
  name: string;
  /** Human-readable source attribution, e.g. the State Council notice title. */
  source?: string;
  sourceUrl?: string;
  lastUpdated?: string;
  weekStart: 0 | 1;
  weekends: number[];
  workingHours: WorkingHours;
  holidays: Calendar['holidays'];
}

const CALENDAR_FILES = {
  'zh-CN': zhCN,
} as const;

export type CalendarRegion = keyof typeof CALENDAR_FILES;

/** Returns the dataset for a region. Throws for unknown regions. */
export function getCalendarData(region: CalendarRegion | string): CalendarData {
  const key = region as CalendarRegion;
  const data = CALENDAR_FILES[key];
  if (!data) {
    throw new Error(
      `Unknown calendar region: ${region}. Available: ${Object.keys(CALENDAR_FILES).join(', ')}`,
    );
  }
  return data as CalendarData;
}

/** Lists all bundled regions. */
export function listCalendarRegions(): CalendarRegion[] {
  return Object.keys(CALENDAR_FILES) as CalendarRegion[];
}

/**
 * Returns the dataset cast to the runtime `Calendar` shape (drops the
 * provenance fields). Use this when populating a `GanttlyFile.calendar`.
 */
export function getCalendar(region: CalendarRegion | string): Calendar {
  const data = getCalendarData(region);
  return {
    id: data.id,
    weekStart: data.weekStart,
    weekends: data.weekends,
    holidays: data.holidays,
    workingHours: data.workingHours,
  };
}
