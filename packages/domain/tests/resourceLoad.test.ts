import { describe, expect, it } from 'vitest';
import { computeResourceLoad, loadOn, peakLoad } from '../src/resourceLoad';
import type { Task, Resource } from '@ganttly/schema';
import { resolveCalendar } from '../src/calendar';

const cal = resolveCalendar({
  id: 'test',
  weekStart: 1,
  weekends: [0, 6],
  holidays: [],
  workingHours: { start: '09:00', end: '18:00' },
});

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-01-05', // Monday
    end: '2026-01-09', // Friday (5 working days)
    duration: 5,
    overtimeDates: [],
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
    ...overrides,
  };
}

describe('computeResourceLoad', () => {
  it('returns empty maps for resources with no assignments', () => {
    const resources: Resource[] = [{ id: 'r1', name: 'Alice', capacity: 1.0 }];
    const tasks = [makeTask('t1')];
    const load = computeResourceLoad(tasks, resources, cal);
    expect(load.get('r1')?.size).toBe(0);
  });

  it('accumulates load across each working day of a task', () => {
    const resources: Resource[] = [{ id: 'r1', name: 'Alice', capacity: 1.0 }];
    const tasks = [makeTask('t1', { assignments: [{ resourceId: 'r1', load: 50 }] })];
    const load = computeResourceLoad(tasks, resources, cal);
    // 5 working days (Mon-Fri), each at 50%
    expect(load.get('r1')?.get('2026-01-05')).toBe(50);
    expect(load.get('r1')?.get('2026-01-09')).toBe(50);
    expect(load.get('r1')?.get('2026-01-10')).toBeUndefined(); // Saturday
  });

  it('sums load additively when one resource is on overlapping tasks', () => {
    // Grilling example: A on X (30%) + Y (70%) over the same days = 100%.
    const resources: Resource[] = [{ id: 'r1', name: 'A', capacity: 1.0 }];
    const tasks = [
      makeTask('x', { assignments: [{ resourceId: 'r1', load: 30 }] }),
      makeTask('y', { assignments: [{ resourceId: 'r1', load: 70 }] }),
    ];
    const load = computeResourceLoad(tasks, resources, cal);
    expect(loadOn(load, 'r1', '2026-01-05')).toBe(100);
    expect(loadOn(load, 'r1', '2026-01-07')).toBe(100);
  });

  it('detects overload when overlapping loads exceed 100', () => {
    const resources: Resource[] = [{ id: 'r1', name: 'A', capacity: 1.0 }];
    const tasks = [
      makeTask('x', { assignments: [{ resourceId: 'r1', load: 60 }] }),
      makeTask('y', { assignments: [{ resourceId: 'r1', load: 60 }] }),
    ];
    const load = computeResourceLoad(tasks, resources, cal);
    expect(loadOn(load, 'r1', '2026-01-06')).toBe(120);
    expect(peakLoad(load, 'r1')).toBe(120);
  });

  it('skips assignments referencing unknown resources', () => {
    const resources: Resource[] = [{ id: 'r1', name: 'A', capacity: 1.0 }];
    const tasks = [makeTask('t1', { assignments: [{ resourceId: 'ghost', load: 50 }] })];
    const load = computeResourceLoad(tasks, resources, cal);
    expect(load.get('ghost')).toBeUndefined();
    expect(load.get('r1')?.size).toBe(0);
  });

  it('loads only explicitly marked rest days inside a cross-week task', () => {
    const resources: Resource[] = [{ id: 'r1', name: 'A', capacity: 1.0 }];
    const tasks = [
      makeTask('t1', {
        start: '2026-01-05',
        end: '2026-01-12',
        duration: 6,
        overtimeDates: ['2026-01-10'],
        assignments: [{ resourceId: 'r1', load: 100 }],
      }),
    ];
    const load = computeResourceLoad(tasks, resources, cal);
    expect(loadOn(load, 'r1', '2026-01-10')).toBe(100); // Sat (overtime)
    expect(loadOn(load, 'r1', '2026-01-11')).toBe(0); // Sun (unmarked)
    expect(loadOn(load, 'r1', '2026-01-05')).toBe(100); // Mon
  });

  it('peakLoad returns 0 for an unloaded resource', () => {
    const resources: Resource[] = [{ id: 'r1', name: 'A', capacity: 1.0 }];
    const load = computeResourceLoad([], resources, cal);
    expect(peakLoad(load, 'r1')).toBe(0);
  });
});
