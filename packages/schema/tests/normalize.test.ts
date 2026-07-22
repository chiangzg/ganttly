import { describe, expect, it } from 'vitest';
import { createEmptyFile, normalizeFile, validateGanttlyFile } from '../src/index.js';
import type { GanttlyFile, Holiday } from '../src/index.js';

const HOLIDAYS: Holiday[] = [
  { date: '2026-01-01', name: '元旦', type: 'holiday' },
  { date: '2026-02-17', name: '春节', type: 'holiday' },
];
const getHolidays = (_region: string): Holiday[] => HOLIDAYS;

describe('normalizeFile', () => {
  it('is a no-op on a freshly created empty file when no holiday provider is given', () => {
    const file = createEmptyFile({ name: 'fresh' });
    const out = normalizeFile(file); // no provider → holidays stay empty
    expect(out).toEqual(file);
  });

  it('backfills zh-CN holidays when the list is empty', () => {
    const file = createEmptyFile();
    // sanity: createEmptyFile ships empty holidays
    expect(file.calendar.holidays).toHaveLength(0);
    const out = normalizeFile(file, { getHolidays });
    expect(out.calendar.holidays).toEqual(HOLIDAYS);
  });

  it('does not backfill holidays when they are already populated', () => {
    const existing: Holiday[] = [{ date: '2026-05-01', name: '劳动节', type: 'holiday' }];
    const file: GanttlyFile = {
      ...createEmptyFile(),
      calendar: { ...createEmptyFile().calendar, holidays: existing },
    };
    const out = normalizeFile(file, { getHolidays });
    expect(out.calendar.holidays).toEqual(existing);
  });

  it('does not backfill holidays for a non-zh-CN calendar', () => {
    const file: GanttlyFile = {
      ...createEmptyFile(),
      calendar: {
        ...createEmptyFile().calendar,
        id: 'en',
        holidays: [],
      },
    };
    const out = normalizeFile(file, { getHolidays });
    expect(out.calendar.holidays).toHaveLength(0);
  });

  it('does not backfill holidays when no provider is given', () => {
    const file = createEmptyFile();
    const out = normalizeFile(file); // no options.getHolidays
    expect(out.calendar.holidays).toHaveLength(0);
  });

  it('does not mutate the input file', () => {
    const file = createEmptyFile();
    const snapshot = JSON.parse(JSON.stringify(file));
    normalizeFile(file, { getHolidays });
    expect(file).toEqual(snapshot);
  });

  it('is idempotent', () => {
    const file = createEmptyFile();
    const once = normalizeFile(file, { getHolidays });
    const twice = normalizeFile(once, { getHolidays });
    expect(twice).toEqual(once);
  });

  it('passes validation after normalization', () => {
    const file = createEmptyFile();
    const out = normalizeFile(file, { getHolidays });
    const result = validateGanttlyFile(out);
    expect(result.ok).toBe(true);
  });

  it('defaults missing Resource.capacity to 1.0', () => {
    const base = createEmptyFile();
    const file: GanttlyFile = {
      ...base,
      resources: [
        { id: 'r1', name: 'Alice' }, // no capacity
        { id: 'r2', name: 'Bob', capacity: 0.5 }, // explicit
      ],
    };
    const out = normalizeFile(file, { getHolidays });
    expect(out.resources[0].capacity).toBe(1.0);
    expect(out.resources[1].capacity).toBe(0.5); // untouched
  });

  it('does not touch resources when all have capacity', () => {
    const base = createEmptyFile();
    const file: GanttlyFile = {
      ...base,
      resources: [{ id: 'r1', name: 'Alice', capacity: 0.8 }],
    };
    const out = normalizeFile(file, { getHolidays });
    expect(out.resources).toEqual(file.resources);
  });

  it('defaults missing/empty TaskConstraints to { type: "none" }', () => {
    const base = createEmptyFile();
    const file: GanttlyFile = {
      ...base,
      tasks: [
        // @ts-expect-error — simulating an old MVP file with empty constraints
        {
          id: 't1',
          name: 'T1',
          parentId: null,
          order: 0,
          start: '2026-01-05',
          end: '2026-01-09',
          duration: 5,
          progress: 0,
          isMilestone: false,
          dependencies: [],
          constraints: {},
          assignments: [],
          customFields: {},
        },
      ],
    };
    const out = normalizeFile(file, { getHolidays });
    expect(out.tasks[0]!.constraints).toEqual({ type: 'none' });
  });

  it('preserves an existing non-none constraint', () => {
    const base = createEmptyFile();
    const file: GanttlyFile = {
      ...base,
      tasks: [
        {
          id: 't1',
          name: 'T1',
          parentId: null,
          order: 0,
          start: '2026-01-05',
          end: '2026-01-09',
          duration: 5,
          progress: 0,
          isMilestone: false,
          dependencies: [],
          constraints: { type: 'mustStartOn', date: '2026-01-05' },
          assignments: [],
          customFields: {},
        },
      ],
    };
    const out = normalizeFile(file, { getHolidays });
    expect(out.tasks[0]!.constraints).toEqual({ type: 'mustStartOn', date: '2026-01-05' });
  });
});
