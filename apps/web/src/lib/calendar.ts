/**
 * Calendar math: working-day vs non-working-day decisions, plus duration math.
 *
 * Central to PRD pain point B (Chinese holidays). All functions are pure;
 * the calendar object is treated as immutable reference data.
 *
 * Rules:
 * - A day is a non-working day if EITHER it is in the weekend set, OR it
 *   appears in `holidays` with type `holiday`.
 * - A day is a working day if EITHER it does not match the above, OR it
 *   appears in `holidays` with type `working` (调休补班 overrides weekend).
 * - Durations are expressed in working days. `addWorkingDays` skips
 *   non-working days, counting only working days.
 */
import type { Calendar, Holiday } from '@ganttly/schema';

export interface ResolvedCalendar {
  weekStart: 0 | 1;
  weekends: ReadonlySet<number>;
  /** Map of `YYYY-MM-DD` -> Holiday, for O(1) lookups. */
  holidays: ReadonlyMap<string, Holiday>;
}

/** Pre-compute a `ResolvedCalendar` once per project, then reuse. */
export function resolveCalendar(calendar: Calendar): ResolvedCalendar {
  const holidayMap = new Map<string, Holiday>();
  for (const h of calendar.holidays) {
    holidayMap.set(h.date, h);
  }
  return {
    weekStart: calendar.weekStart,
    weekends: new Set(calendar.weekends),
    holidays: holidayMap,
  };
}

/**
 * Returns the day-of-week (0=Sun ... 6=Sat) for an ISO date string.
 * Implemented without Date parsing to avoid timezone drift: we want the
 * calendar day, not the local-time interpretation of UTC midnight.
 */
export function dayOfWeek(isoDate: string): number {
  // Parse manually so 2026-01-01 always returns the same weekday regardless
  // of host timezone. Date.getUTCDay() is safe after constructing from Y-M-D.
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }
  // Months are 1-indexed in our format; Date uses 0-indexed months.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Returns `YYYY-MM-DD` for the given year/month/day (1-indexed month). */
export function toISODate(year: number, month1: number, day: number): string {
  const mm = String(month1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Parse `YYYY-MM-DD` into a `{year, month, day}` triple (month 1-indexed). */
export function fromISODate(isoDate: string): { year: number; month: number; day: number } {
  const [y, m, d] = isoDate.split('-').map(Number);
  return { year: y!, month: m!, day: d! };
}

/** Add `n` calendar days to an ISO date (n may be negative). */
export function addCalendarDays(isoDate: string, n: number): string {
  const { year, month, day } = fromISODate(isoDate);
  const ms = Date.UTC(year, month - 1, day) + n * 86_400_000;
  const d = new Date(ms);
  return toISODate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Returns true if the given ISO date is a working day under this calendar. */
export function isWorkingDay(isoDate: string, cal: ResolvedCalendar): boolean {
  const explicit = cal.holidays.get(isoDate);
  if (explicit) {
    // Explicit entries override weekend defaults either way.
    return explicit.type === 'working';
  }
  return !cal.weekends.has(dayOfWeek(isoDate));
}

/** Returns true if the given ISO date is a non-working day (weekend or holiday). */
export function isNonWorkingDay(isoDate: string, cal: ResolvedCalendar): boolean {
  return !isWorkingDay(isoDate, cal);
}

/** Returns the holiday metadata for a date, or undefined if it's a plain working day. */
export function getHoliday(isoDate: string, cal: ResolvedCalendar): Holiday | undefined {
  return cal.holidays.get(isoDate);
}

/**
 * Returns the next working day ON OR AFTER `isoDate`. Useful when a drag lands
 * on a weekend — the engine snaps forward to the next valid workday.
 */
export function nextWorkingDay(isoDate: string, cal: ResolvedCalendar): string {
  let cursor = isoDate;
  // Guard against infinite loops on pathological calendars.
  for (let i = 0; i < 366; i++) {
    if (isWorkingDay(cursor, cal)) return cursor;
    cursor = addCalendarDays(cursor, 1);
  }
  return isoDate;
}

/**
 * Returns the previous working day ON OR BEFORE `isoDate`.
 */
export function prevWorkingDay(isoDate: string, cal: ResolvedCalendar): string {
  let cursor = isoDate;
  for (let i = 0; i < 366; i++) {
    if (isWorkingDay(cursor, cal)) return cursor;
    cursor = addCalendarDays(cursor, -1);
  }
  return isoDate;
}

/**
 * Compute the end date (inclusive) given a start date and a working-day
 * duration. A duration of 1 → start === end. A duration of 5 starting on a
 * Monday ends on Friday of the same week.
 */
export function endDateFromDuration(
  startISO: string,
  duration: number,
  cal: ResolvedCalendar,
): string {
  if (duration <= 0) return startISO;
  // Walk forward from start, counting working days. The first working day is
  // the start itself, then we step (duration-1) more working days.
  let cursor = nextWorkingDay(startISO, cal);
  if (cursor !== startISO) {
    // Start was a non-working day; we've already snapped forward, that counts
    // as the first working day.
  }
  let counted = 1;
  while (counted < duration) {
    cursor = addCalendarDays(cursor, 1);
    if (isWorkingDay(cursor, cal)) counted++;
  }
  return cursor;
}

/**
 * Compute the working-day duration between an inclusive start and inclusive
 * end date. Returns 0 if the start is a non-working day that the end never
 * reaches a working day on.
 */
export function durationBetween(startISO: string, endISO: string, cal: ResolvedCalendar): number {
  if (endISO < startISO) return 0;
  let cursor = startISO;
  let count = 0;
  // Cap to avoid pathological cycles.
  for (let i = 0; i < 10_000 && cursor <= endISO; i++) {
    if (isWorkingDay(cursor, cal)) count++;
    cursor = addCalendarDays(cursor, 1);
  }
  return count;
}

/** Iterate all working days in `[startISO, endISO]` inclusive. */
export function* iterateWorkingDays(
  startISO: string,
  endISO: string,
  cal: ResolvedCalendar,
): Generator<string> {
  let cursor = startISO;
  while (cursor <= endISO) {
    if (isWorkingDay(cursor, cal)) yield cursor;
    cursor = addCalendarDays(cursor, 1);
  }
}
