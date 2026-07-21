import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  dayOfWeek,
  durationBetween,
  endDateFromDuration,
  fromISODate,
  isNonWorkingDay,
  isWorkingDay,
  nextWorkingDay,
  prevWorkingDay,
  resolveCalendar,
  toISODate,
} from '@/lib/calendar';
import { getCalendar } from '@ganttly/calendar-data';
import type { Calendar } from '@ganttly/schema';

const zhCN = getCalendar('zh-CN');
const cal = resolveCalendar(zhCN);

describe('toISODate / fromISODate roundtrip', () => {
  it('formats and parses correctly', () => {
    expect(toISODate(2026, 1, 5)).toBe('2026-01-05');
    expect(fromISODate('2026-01-05')).toEqual({ year: 2026, month: 1, day: 5 });
  });
});

describe('addCalendarDays', () => {
  it('handles positive and negative deltas', () => {
    expect(addCalendarDays('2026-03-01', 10)).toBe('2026-03-11');
    expect(addCalendarDays('2026-03-11', -10)).toBe('2026-03-01');
    expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('crosses year boundary correctly', () => {
    expect(addCalendarDays('2025-12-30', 5)).toBe('2026-01-04');
  });
});

describe('dayOfWeek', () => {
  // 2026-01-05 is a Monday (verified externally)
  it('returns 1 for Monday 2026-01-05', () => {
    expect(dayOfWeek('2026-01-05')).toBe(1);
  });
  it('returns 0 for Sunday 2026-01-04', () => {
    expect(dayOfWeek('2026-01-04')).toBe(0);
  });
  it('returns 6 for Saturday 2026-01-03', () => {
    expect(dayOfWeek('2026-01-03')).toBe(6);
  });
});

describe('isWorkingDay with zh-CN 2026', () => {
  it('treats Saturday/Sunday as non-working by default', () => {
    expect(isWorkingDay('2026-01-10', cal)).toBe(false); // Saturday
    expect(isWorkingDay('2026-01-11', cal)).toBe(false); // Sunday
    expect(isWorkingDay('2026-01-05', cal)).toBe(true); // Monday
  });

  it('honors New Year holiday 2026-01-01..03', () => {
    expect(isWorkingDay('2026-01-01', cal)).toBe(false);
    expect(isWorkingDay('2026-01-02', cal)).toBe(false);
    expect(isWorkingDay('2026-01-03', cal)).toBe(false); // weekend + holiday
  });

  it('honors Spring Festival 2026 (Feb 15-22)', () => {
    for (const d of [
      '2026-02-15',
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-02-19',
      '2026-02-20',
      '2026-02-21',
      '2026-02-22',
    ]) {
      expect(isWorkingDay(d, cal), `${d} should be holiday`).toBe(false);
    }
  });

  it('treats Spring Festival make-up days (调休) as working', () => {
    // 2026-02-14 is a Saturday but is make-up working day
    expect(isWorkingDay('2026-02-14', cal)).toBe(true);
    // 2026-02-28 is a Saturday make-up
    expect(isWorkingDay('2026-02-28', cal)).toBe(true);
  });

  it('honors National Day 2026 (Oct 1-8)', () => {
    for (let d = 1; d <= 8; d++) {
      const iso = `2026-10-${String(d).padStart(2, '0')}`;
      expect(isWorkingDay(iso, cal), `${iso}`).toBe(false);
    }
  });

  it('treats National Day make-up days (Sep 19, Oct 10) as working', () => {
    expect(isWorkingDay('2026-09-19', cal)).toBe(true); // Saturday make-up
    expect(isWorkingDay('2026-10-10', cal)).toBe(true); // Saturday make-up
  });

  it('honors all 7 statutory holidays (at least one non-working date each)', () => {
    const holidays = [
      { name: '元旦', sample: '2026-01-01' },
      { name: '春节', sample: '2026-02-17' },
      { name: '清明', sample: '2026-04-04' },
      { name: '劳动', sample: '2026-05-01' },
      { name: '端午', sample: '2026-06-19' },
      { name: '中秋', sample: '2026-09-25' },
      { name: '国庆', sample: '2026-10-01' },
    ];
    for (const h of holidays) {
      expect(isNonWorkingDay(h.sample, cal), `${h.name}: ${h.sample}`).toBe(true);
    }
  });
});

describe('nextWorkingDay / prevWorkingDay', () => {
  it('returns same date if it is already a working day', () => {
    expect(nextWorkingDay('2026-01-05', cal)).toBe('2026-01-05'); // Monday
  });
  it('skips a weekend forward', () => {
    expect(nextWorkingDay('2026-01-10', cal)).toBe('2026-01-12'); // Sat → Mon
  });
  it('skips a long holiday forward (Spring Festival)', () => {
    expect(nextWorkingDay('2026-02-15', cal)).toBe('2026-02-23'); // after the 8-day break
  });
  it('skips backward over a weekend', () => {
    expect(prevWorkingDay('2026-01-11', cal)).toBe('2026-01-09'); // Sun → Fri
  });
});

describe('endDateFromDuration', () => {
  it('5-day duration starting Monday ends Friday', () => {
    expect(endDateFromDuration('2026-01-05', 5, cal)).toBe('2026-01-09');
  });

  it('duration spanning a weekend wraps to next week', () => {
    // Mon Jan 5 + 7 working days: Jan 5,6,7,8,9,12,13 → end Jan 13
    // (skips Jan 10-11 weekend)
    expect(endDateFromDuration('2026-01-05', 7, cal)).toBe('2026-01-13');
  });

  it('duration 0 returns start', () => {
    expect(endDateFromDuration('2026-01-05', 0, cal)).toBe('2026-01-05');
  });

  it('duration spanning Spring Festival is correctly elongated', () => {
    // Start Mon 2026-02-09, duration 5 working days.
    // Working days available: Feb 9, 10, 11, 12, 13, then holiday Feb 14-22
    // (Feb 14 is make-up working so it counts), then Feb 23+
    // So 5 working days from Feb 9: Feb 9, 10, 11, 12, 13 → end = Feb 13.
    expect(endDateFromDuration('2026-02-09', 5, cal)).toBe('2026-02-13');
  });
});

describe('durationBetween', () => {
  it('counts working days inclusive', () => {
    expect(durationBetween('2026-01-05', '2026-01-09', cal)).toBe(5); // Mon-Fri
  });
  it('skips weekends', () => {
    expect(durationBetween('2026-01-05', '2026-01-12', cal)).toBe(6); // Mon-Mon skips Sat/Sun
  });
  it('returns 0 when end < start', () => {
    expect(durationBetween('2026-01-09', '2026-01-05', cal)).toBe(0);
  });
});

describe('empty-calendar edge cases', () => {
  const emptyCal = resolveCalendar({
    id: 'test',
    weekStart: 1,
    weekends: [0, 6],
    holidays: [],
    workingHours: { start: '09:00', end: '18:00' },
  } satisfies Calendar);

  it('treats plain weekends as non-working', () => {
    expect(isWorkingDay('2026-01-10', emptyCal)).toBe(false);
    expect(isWorkingDay('2026-01-05', emptyCal)).toBe(true);
  });
});
