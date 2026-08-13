import { describe, expect, it } from 'vitest';
import type { GanttlyFile } from '@ganttly/schema';
import { computeProjectStats } from '../../../src/modules/projects/summary';

function fileWith(tasks: GanttlyFile['tasks']): GanttlyFile {
  return {
    schemaVersion: 1,
    project: { name: 'T', locale: 'zh-CN' },
    calendar: {
      id: 'zh-CN',
      weekStart: 1,
      weekends: [0, 6],
      holidays: [],
      workingHours: { start: '09:00', end: '18:00' },
    },
    tasks,
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
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      appVersion: '0.1.0',
    },
  };
}

describe('computeProjectStats', () => {
  it('returns zeroed stats for an empty project', () => {
    expect(computeProjectStats(fileWith([]))).toEqual({
      taskCount: 0,
      completedTaskCount: 0,
      progress: 0,
    });
  });

  it('counts only leaf tasks, weights progress by duration, and finds the date range', () => {
    // S is a parent (summary); A and B are its leaves.
    const file = fileWith([
      {
        id: 'S',
        name: 'Summary',
        parentId: null,
        order: 0,
        start: '2026-01-01',
        end: '2026-01-06',
        duration: 5,
        progress: 0,
        isMilestone: false,
        dependencies: [],
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
      },
      {
        id: 'A',
        name: 'A',
        parentId: 'S',
        order: 0,
        start: '2026-01-05',
        end: '2026-01-06',
        duration: 2,
        progress: 50,
        isMilestone: false,
        dependencies: [],
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
      },
      {
        id: 'B',
        name: 'B',
        parentId: 'S',
        order: 1,
        start: '2026-01-01',
        end: '2026-01-02',
        duration: 2,
        progress: 100,
        isMilestone: false,
        dependencies: [],
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
      },
    ]);
    expect(computeProjectStats(file)).toEqual({
      taskCount: 2,
      completedTaskCount: 1,
      // weighted = (50*2 + 100*2) / (2+2) = 75
      progress: 75,
      startDate: '2026-01-01',
      endDate: '2026-01-06',
    });
  });
});
