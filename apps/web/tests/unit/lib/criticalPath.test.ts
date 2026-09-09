import { describe, expect, it } from 'vitest';
import { computeProjectCriticalPath } from '@/lib/criticalPath';
import { buildFilterPredicate } from '@/lib/taskFilter';
import { createEmptyFile, createDefaultTask, type GanttlyFile, type Task } from '@ganttly/schema';

function makeFile(tasks: Task[]): GanttlyFile {
  return { ...createEmptyFile({ name: 'test' }), tasks };
}

/** NOTE: createDefaultTask ignores progress/assignments/dependencies options. */
function makeTask(id: string, start: string, overrides: Partial<Task> = {}): Task {
  const t = createDefaultTask({ id, name: id, start, parentId: null, order: 0 });
  return { ...t, ...overrides };
}

function makeParent(id: string, start: string, overrides: Partial<Task> = {}): Task {
  return makeTask(id, start, overrides);
}

// July 2026: 07-01 is a Wednesday; weekends 04/05, 11/12, 18/19, 25/26.

describe('computeProjectCriticalPath', () => {
  it('excludes summaries from the CPM graph — rollup effort-sum cannot inflate the project end', () => {
    // Overlapping siblings: effort sum 20wd but the group's time span is only
    // 15wd (07-01 … 07-21). The stale parent duration 100 must be irrelevant.
    const g1 = makeTask('g1', '2026-07-01', { parentId: 'G', duration: 10, end: '2026-07-14' });
    const g2 = makeTask('g2', '2026-07-08', { parentId: 'G', duration: 10, end: '2026-07-21' });
    const G = makeParent('G', '2026-07-01', { duration: 100 });
    // X is the true longest chain: 16wd ending 07-22.
    const x = makeTask('x', '2026-07-01', { duration: 16, end: '2026-07-22' });

    const { leafCriticalIds, criticalTaskIds } = computeProjectCriticalPath(
      [G, g1, g2, x],
      makeFile([G, g1, g2, x]).calendar,
    );

    expect(leafCriticalIds).toEqual(new Set(['x']));
    // Summary G must NOT derive red — none of its children is critical.
    expect(criticalTaskIds).toEqual(new Set(['x']));
  });

  it('derives summary criticality from critical leaf descendants', () => {
    // Chain h1 → h2(milestone) is the longest; Y is short. The summary H must
    // turn red even though it never entered the graph.
    const h1 = makeTask('h1', '2026-07-01', { parentId: 'H', duration: 10, end: '2026-07-14' });
    const h2 = makeTask('h2', '2026-07-15', {
      parentId: 'H',
      duration: 0,
      end: '2026-07-15',
      isMilestone: true,
      dependencies: [{ targetId: 'h1', type: 'FS', lag: 0 }],
    });
    const H = makeParent('H', '2026-07-01', { duration: 42 });
    const y = makeTask('y', '2026-07-01', { duration: 5, end: '2026-07-07' });

    const { leafCriticalIds, criticalTaskIds } = computeProjectCriticalPath(
      [H, h1, h2, y],
      makeFile([H, h1, h2, y]).calendar,
    );

    // Milestones are leaves: the milestone closes the chain.
    expect(leafCriticalIds).toEqual(new Set(['h1', 'h2']));
    expect(criticalTaskIds).toEqual(new Set(['h1', 'h2', 'H']));
  });

  it('ignores dependencies pointing at a summary (defensive for legacy data)', () => {
    const g1 = makeTask('g1', '2026-07-01', { parentId: 'G', duration: 10, end: '2026-07-14' });
    const G = makeParent('G', '2026-07-01');
    // z depends on the SUMMARY — the dep must vanish from the graph, leaving z
    // as a root anchored at its own start.
    const z = makeTask('z', '2026-07-01', {
      duration: 5,
      end: '2026-07-07',
      dependencies: [{ targetId: 'G', type: 'FS', lag: 0 }],
    });

    // z is an independent root now (5wd ending 07-07) — it floats against the
    // 07-14 project end, so only g1 is critical and G derives red from g1.
    const { leafCriticalIds, criticalTaskIds } = computeProjectCriticalPath(
      [G, g1, z],
      makeFile([G, g1, z]).calendar,
    );

    expect(leafCriticalIds).toEqual(new Set(['g1']));
    expect(criticalTaskIds).toEqual(new Set(['g1', 'G']));
  });

  it('matches the criticalPath quick filter exactly (single computation source)', () => {
    const h1 = makeTask('h1', '2026-07-01', { parentId: 'H', duration: 10, end: '2026-07-14' });
    const h2 = makeTask('h2', '2026-07-15', {
      parentId: 'H',
      duration: 0,
      end: '2026-07-15',
      isMilestone: true,
      dependencies: [{ targetId: 'h1', type: 'FS', lag: 0 }],
    });
    const H = makeParent('H', '2026-07-01');
    const y = makeTask('y', '2026-07-01', { duration: 5, end: '2026-07-07' });
    const file = makeFile([H, h1, h2, y]);

    const { criticalTaskIds } = computeProjectCriticalPath(file.tasks, file.calendar);
    const predicate = buildFilterPredicate(file, 'criticalPath');
    const matched = file.tasks.filter((t) => predicate?.(t)).map((t) => t.id);

    // The filter targets leaves only, but must agree with the same CPM run.
    expect(new Set(matched)).toEqual(new Set([...criticalTaskIds].filter((id) => id !== 'H')));
  });
});
