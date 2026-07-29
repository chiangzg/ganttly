import { describe, expect, it } from 'vitest';
import {
  createEmptyFile,
  normalizeFile,
  stripUnknownFields,
  validateGanttlyFile,
} from '../src/index.js';
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

  it('defaults and canonicalizes task overtime dates', () => {
    const base = createEmptyFile();
    const task = {
      id: 't1',
      name: 'T1',
      parentId: null,
      order: 0,
      start: '2026-01-05',
      end: '2026-01-12',
      duration: 6,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: { type: 'none' as const },
      assignments: [],
      customFields: {},
    };
    const file: GanttlyFile = {
      ...base,
      tasks: [
        task,
        {
          ...task,
          id: 't2',
          overtimeDates: ['2026-01-10', '2026-01-04', '2026-01-10', '2026-01-11'],
        },
      ],
    };
    const snapshot = structuredClone(file);

    const out = normalizeFile(file, { getHolidays });

    expect(out.tasks[0]!.overtimeDates).toEqual([]);
    expect(out.tasks[1]!.overtimeDates).toEqual(['2026-01-10', '2026-01-11']);
    expect(file).toEqual(snapshot);
    expect(normalizeFile(out, { getHolidays })).toEqual(out);
  });

  // ----- forward-compatibility: unknown-field stripping ---------------------
  it('strips unknown task keys and reports them via onStripped', () => {
    const base = createEmptyFile();
    // @ts-expect-error — simulating a NEWER app's export carrying unknown fields
    const file: GanttlyFile = {
      ...base,
      tasks: [
        {
          ...base.tasks[0],
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
          constraints: { type: 'none' },
          assignments: [],
          customFields: {},
          overtimeDates: ['2026-01-06'], // KNOWN to current schema -> must stay
          legacyField: 'oops', // unknown -> strip
          anotherUnknown: 123, // unknown -> strip
        },
      ],
    };
    const snapshot = structuredClone(file);
    const stripped: string[] = [];

    const out = normalizeFile(file, { getHolidays, onStripped: (p) => stripped.push(...p) });

    expect(out.tasks[0]!.overtimeDates).toEqual(['2026-01-06']); // preserved
    expect('legacyField' in out.tasks[0]!).toBe(false);
    expect('anotherUnknown' in out.tasks[0]!).toBe(false);
    // Reports both unknown keys, at the task path.
    expect(stripped).toContain('tasks[0].legacyField');
    expect(stripped).toContain('tasks[0].anotherUnknown');
    // Does not mutate the input.
    expect(file).toEqual(snapshot);
    // The normalized file now validates.
    expect(validateGanttlyFile(out).ok).toBe(true);
  });

  it('strips nested unknown keys (assignment / dependency)', () => {
    const base = createEmptyFile();
    // @ts-expect-error — injecting nested unknown fields
    const file: GanttlyFile = {
      ...base,
      tasks: [
        {
          ...base.tasks[0],
          id: 't1',
          name: 'T1',
          parentId: null,
          order: 0,
          start: '2026-01-05',
          end: '2026-01-09',
          duration: 5,
          progress: 0,
          isMilestone: false,
          dependencies: [
            { targetId: 'p1', type: 'FS', lag: 0, stray: 'x' }, // stray -> strip
          ],
          constraints: { type: 'none' },
          assignments: [
            { resourceId: 'r1', load: 100, bogus: true }, // bogus -> strip
          ],
          customFields: {},
        },
      ],
    };
    const stripped: string[] = [];
    const out = normalizeFile(file, { onStripped: (p) => stripped.push(...p) });

    expect('stray' in out.tasks[0]!.dependencies[0]!).toBe(false);
    expect('bogus' in out.tasks[0]!.assignments[0]!).toBe(false);
    expect(stripped).toEqual(
      expect.arrayContaining(['tasks[0].dependencies[0].stray', 'tasks[0].assignments[0].bogus']),
    );
    expect(validateGanttlyFile(out).ok).toBe(true);
  });

  it('does not call onStripped when there is nothing to strip', () => {
    const file = createEmptyFile();
    const stripped: string[] = [];
    normalizeFile(file, { onStripped: (p) => stripped.push(...p) });
    expect(stripped).toEqual([]);
  });

  it('leaves a schema-valid file unchanged via stripUnknownFields', () => {
    const file = createEmptyFile();
    const { file: out, removed } = stripUnknownFields(file);
    expect(removed).toEqual([]);
    expect(out).toEqual(file);
  });
});

describe('stripUnknownFields', () => {
  it('is idempotent', () => {
    const base = createEmptyFile();
    // @ts-expect-error — injecting an unknown key
    const file: GanttlyFile = { ...base, tasks: [{ ...base.tasks[0], legacy: 1 }] };
    const once = stripUnknownFields(file);
    const twice = stripUnknownFields(once.file);
    expect(twice.removed).toEqual([]);
    expect(twice.file).toEqual(once.file);
  });

  it('does not mutate the input', () => {
    const base = createEmptyFile();
    // @ts-expect-error — injecting an unknown key
    const file: GanttlyFile = { ...base, tasks: [{ ...base.tasks[0], legacy: 1 }] };
    const snapshot = structuredClone(file);
    stripUnknownFields(file);
    expect(file).toEqual(snapshot);
  });
});
