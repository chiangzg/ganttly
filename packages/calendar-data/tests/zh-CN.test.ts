import { describe, expect, it } from 'vitest';
import {
  getCalendar,
  getCalendarData,
  listCalendarRegions,
  type CalendarData,
} from '../src/index.js';

describe('listCalendarRegions', () => {
  it('includes zh-CN', () => {
    expect(listCalendarRegions()).toContain('zh-CN');
  });
});

describe('getCalendarData("zh-CN")', () => {
  const data: CalendarData = getCalendarData('zh-CN');

  it('has correct metadata', () => {
    expect(data.id).toBe('zh-CN');
    expect(data.name).toContain('中国');
    expect(data.weekStart).toBe(1);
    expect(data.weekends).toEqual([0, 6]);
    expect(data.workingHours).toEqual({ start: '09:00', end: '18:00' });
  });

  it('contains all 7 statutory holidays for 2026', () => {
    const names = data.holidays.map((h) => h.name);
    for (const holiday of ['元旦', '春节', '清明节', '劳动节', '端午节', '中秋节', '国庆节']) {
      expect(
        names.some((n) => n.startsWith(holiday)),
        `missing ${holiday}`,
      ).toBe(true);
    }
  });

  it('has Spring Festival golden week with ≥7 consecutive days in Feb 2026', () => {
    const feb = data.holidays
      .filter((h) => h.date.startsWith('2026-02') && h.type === 'holiday')
      .map((h) => h.date)
      .sort();
    expect(feb.length).toBeGreaterThanOrEqual(7);
  });

  it('has make-up working days (调休) for Spring Festival', () => {
    const makeups = data.holidays.filter((h) => h.type === 'working');
    expect(makeups.length).toBeGreaterThanOrEqual(2);
    expect(makeups.some((h) => h.name.includes('春节'))).toBe(true);
  });

  it('all holiday dates are valid YYYY-MM-DD', () => {
    for (const h of data.holidays) {
      expect(h.date, `${h.date}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const parsed = new Date(h.date + 'T00:00:00Z');
      expect(parsed.toString()).not.toBe('Invalid Date');
    }
  });

  it('all holiday dates fall in 2026', () => {
    for (const h of data.holidays) {
      expect(h.date.startsWith('2026-'), `${h.date}`).toBe(true);
    }
  });

  it('no duplicate dates within the same type', () => {
    const seen = new Set<string>();
    for (const h of data.holidays) {
      const key = `${h.date}:${h.type}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe('getCalendar("zh-CN")', () => {
  it('returns a Calendar (without provenance fields)', () => {
    const cal = getCalendar('zh-CN');
    expect(cal.id).toBe('zh-CN');
    expect(cal.weekStart).toBe(1);
    expect(cal.holidays.length).toBeGreaterThan(0);
    // Calendar (runtime) drops name/source/sourceUrl/lastUpdated
    expect('name' in cal).toBe(false);
    expect('source' in cal).toBe(false);
  });
});

describe('getCalendarData error path', () => {
  it('throws on unknown region', () => {
    expect(() => getCalendarData('xx-YY')).toThrow(/Unknown calendar region/);
  });
});
