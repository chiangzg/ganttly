import { describe, expect, it } from 'vitest';
import {
  COLUMN_WIDTH,
  ROW_HEIGHT,
  HEADER_HEIGHT,
  DAYS_PER_COLUMN,
  computeDateExtent,
  dateRangeWidth,
  dateToPixel,
  dayDiff,
  iterateDates,
  pixelToDate,
  pixelsPerDay,
  visibleDateRange,
} from '@/engine/layout';
import type { ZoomLevel } from '@ganttly/schema';
import { addCalendarDays as calAddDays } from '@/lib/calendar';

const ORIGIN = '2026-01-05'; // Monday

describe('layout constants', () => {
  it('exports the expected default values', () => {
    expect(COLUMN_WIDTH.day).toBe(32);
    expect(COLUMN_WIDTH.week).toBe(140);
    expect(ROW_HEIGHT).toBe(32);
    expect(HEADER_HEIGHT).toBe(56);
    expect(DAYS_PER_COLUMN.day).toBe(1);
  });
});

describe('pixelsPerDay', () => {
  it('returns column width for day view', () => {
    expect(pixelsPerDay('day')).toBe(32);
  });
  it('returns 20 px per day for week view (140/7)', () => {
    expect(pixelsPerDay('week')).toBe(20);
  });
});

describe('dayDiff', () => {
  it('counts whole days between two ISO dates', () => {
    expect(dayDiff('2026-01-05', '2026-01-12')).toBe(7);
    expect(dayDiff('2026-01-12', '2026-01-05')).toBe(-7);
    expect(dayDiff('2026-01-05', '2026-01-05')).toBe(0);
  });
  it('crosses month boundary', () => {
    expect(dayDiff('2026-01-30', '2026-02-03')).toBe(4);
  });
  it('crosses year boundary', () => {
    expect(dayDiff('2025-12-30', '2026-01-03')).toBe(4);
  });
  it('handles leap day', () => {
    expect(dayDiff('2024-02-28', '2024-03-01')).toBe(2); // Feb 29 exists in 2024
  });
});

describe('dateToPixel / pixelToDate', () => {
  it('maps origin to pixel 0', () => {
    expect(dateToPixel(ORIGIN, ORIGIN, 'day')).toBe(0);
  });
  it('maps 1 day later to COLUMN_WIDTH.day', () => {
    expect(dateToPixel(calAddDays(ORIGIN, 1), ORIGIN, 'day')).toBe(32);
  });
  it('maps 7 days later to 7*32 in day view', () => {
    expect(dateToPixel(calAddDays(ORIGIN, 7), ORIGIN, 'day')).toBe(224);
  });
  it('maps negative days (before origin)', () => {
    expect(dateToPixel(calAddDays(ORIGIN, -3), ORIGIN, 'day')).toBe(-96);
  });
  it('round-trips through pixelToDate', () => {
    const px = dateToPixel(calAddDays(ORIGIN, 10), ORIGIN, 'day');
    expect(pixelToDate(px, ORIGIN, 'day')).toBe(calAddDays(ORIGIN, 10));
  });
  it('week view: 1 week later = 140 px', () => {
    expect(dateToPixel(calAddDays(ORIGIN, 7), ORIGIN, 'week')).toBe(140);
  });
});

describe('dateRangeWidth', () => {
  it('width is inclusive of both endpoints in day view', () => {
    // Jan 5 to Jan 9 = 5 days * 32 px = 160 px
    expect(dateRangeWidth('2026-01-05', '2026-01-09', 'day')).toBe(160);
  });
});

describe('visibleDateRange', () => {
  it('returns padded window around scroll position', () => {
    const range = visibleDateRange(0, 320, ORIGIN, 'day', 0);
    expect(range.start).toBe(ORIGIN);
    expect(range.end).toBe(calAddDays(ORIGIN, 10));
  });
});

describe('iterateDates', () => {
  it('yields inclusive dates', () => {
    const dates = Array.from(iterateDates('2026-01-05', '2026-01-07'));
    expect(dates).toEqual(['2026-01-05', '2026-01-06', '2026-01-07']);
  });
});

describe('computeDateExtent', () => {
  it('returns fallback range when no tasks', () => {
    const r = computeDateExtent([], '2026-06-01', 7);
    expect(r.start).toBe(calAddDays('2026-06-01', -7));
    expect(r.end).toBe(calAddDays('2026-06-01', 7));
  });
  it('computes min/max with padding', () => {
    const tasks = [
      { start: '2026-02-01', end: '2026-02-10' },
      { start: '2026-01-15', end: '2026-01-20' },
    ];
    const r = computeDateExtent(tasks, '2026-06-01', 0);
    expect(r.start).toBe('2026-01-15');
    expect(r.end).toBe('2026-02-10');
  });
});

describe('round-trip across all zoom levels', () => {
  const zooms: ZoomLevel[] = ['day', 'week', 'month', 'year'];
  for (const z of zooms) {
    it(`${z}: dateToPixel(pixelToDate(x)) is stable for x multiple of pxPerDay`, () => {
      const px = pixelsPerDay(z) * 5;
      const date = pixelToDate(px, ORIGIN, z);
      const back = dateToPixel(date, ORIGIN, z);
      expect(back).toBe(px);
    });
  }
});
