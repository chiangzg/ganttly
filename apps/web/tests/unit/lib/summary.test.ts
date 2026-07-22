import { describe, expect, it } from 'vitest';
import {
  computeRollup,
  computeCascadeRollup,
  isSummaryTask,
  computeAllRollups,
} from '@/lib/summary';
import type { Task } from '@ganttly/schema';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    name: 'test',
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
    ...overrides,
  };
}

describe('computeRollup', () => {
  it('weighted progress calculation — single level parent-child', () => {
    const childA = makeTask({ id: 'A', parentId: 'P', duration: 5, progress: 50 });
    const childB = makeTask({ id: 'B', parentId: 'P', duration: 3, progress: 100 });

    const result = computeRollup([childA, childB]);
    expect(result).not.toBeNull();
    // (50*5 + 100*3) / (5+3) = 550/8 = 68.75 → 69
    expect(result!.progress).toBe(69);
  });

  it('all children 100% → parent 100%', () => {
    const childA = makeTask({ id: 'A', parentId: 'P', progress: 100 });
    const childB = makeTask({ id: 'B', parentId: 'P', progress: 100 });

    const result = computeRollup([childA, childB]);
    expect(result).not.toBeNull();
    expect(result!.progress).toBe(100);
  });

  it('zero-division guard — all children duration=0', () => {
    const childA = makeTask({ id: 'A', parentId: 'P', duration: 0, progress: 40 });
    const childB = makeTask({ id: 'B', parentId: 'P', duration: 0, progress: 60 });

    const result = computeRollup([childA, childB]);
    expect(result).not.toBeNull();
    // Simple arithmetic mean: (40+60)/2 = 50
    expect(result!.progress).toBe(50);
  });

  it('time range derivation — min start, max end', () => {
    const childA = makeTask({
      id: 'A',
      parentId: 'P',
      start: '2026-01-05',
      end: '2026-01-10',
    });
    const childB = makeTask({
      id: 'B',
      parentId: 'P',
      start: '2026-01-08',
      end: '2026-01-15',
    });

    const result = computeRollup([childA, childB]);
    expect(result).not.toBeNull();
    expect(result!.start).toBe('2026-01-05');
    expect(result!.end).toBe('2026-01-15');
  });

  it('returns null for empty children array', () => {
    expect(computeRollup([])).toBeNull();
  });
});

describe('computeCascadeRollup', () => {
  it('multi-level nesting — cascades progress correctly to parent and root', () => {
    const root = makeTask({ id: 'root' });
    const parent = makeTask({ id: 'parent', parentId: 'root' });
    const child = makeTask({ id: 'child', parentId: 'parent', progress: 80, duration: 5 });

    const tasks = [root, parent, child];
    const patches = computeCascadeRollup(tasks, 'child');

    // Should return patches for parent and root (2 ancestors)
    expect(patches).toHaveLength(2);
    expect(patches[0]!.id).toBe('parent');
    expect(patches[1]!.id).toBe('root');
    // Direct parent: single child with progress 80 → 80
    expect(patches[0]!.patch.progress).toBe(80);
    // Root: single summary child `parent`, whose rolled-up progress is 80.
    // Using rolled-up progress (not stale task progress 0), root should be 80.
    expect(patches[1]!.patch.progress).toBe(80);
    // Root still gets the time range and duration from its children
    expect(patches[1]!.patch.duration).toBe(5);
  });

  it('asymmetric multi-level — root progress bubbles up via rolled-up children', () => {
    // root
    //   ├─ mid (summary)
    //   │    └─ leaf1 (duration=4, progress=50)
    //   └─ leaf2 (duration=6, progress=100)
    const root = makeTask({ id: 'root' });
    const mid = makeTask({ id: 'mid', parentId: 'root' });
    const leaf1 = makeTask({ id: 'leaf1', parentId: 'mid', duration: 4, progress: 50 });
    const leaf2 = makeTask({ id: 'leaf2', parentId: 'root', duration: 6, progress: 100 });

    const tasks = [root, mid, leaf1, leaf2];
    const patches = computeCascadeRollup(tasks, 'leaf1');

    const midPatch = patches.find((p) => p.id === 'mid')!;
    const rootPatch = patches.find((p) => p.id === 'root')!;

    // mid: single child leaf1 → progress=50, duration=4
    expect(midPatch.patch.progress).toBe(50);
    expect(midPatch.patch.duration).toBe(4);

    // root: weight(mid)=4 with rolled-up progress 50, weight(leaf2)=6 with progress 100
    //   (50*4 + 100*6) / (4+6) = 800/10 = 80
    expect(rootPatch.patch.progress).toBe(80);
    // Duration sums each child's `duration` field. `mid` has not been re-persisted
    // yet in this pure-function test (its own `duration` is still the default 5),
    // so root.duration = mid.duration(5) + leaf2.duration(6) = 11. In real flows
    // the rollup commands write mid.duration back first, then root sees 4 + 6 = 10.
    expect(rootPatch.patch.duration).toBe(11);
  });

  it('returns empty array when no ancestors', () => {
    const task = makeTask({ id: 'orphan' });
    const patches = computeCascadeRollup([task], 'orphan');
    expect(patches).toHaveLength(0);
  });
});

describe('isSummaryTask', () => {
  it('returns true for tasks with children', () => {
    const parent = makeTask({ id: 'P' });
    const child = makeTask({ id: 'C', parentId: 'P' });
    expect(isSummaryTask('P', [parent, child])).toBe(true);
  });

  it('returns false for leaf tasks', () => {
    const leaf = makeTask({ id: 'L' });
    expect(isSummaryTask('L', [leaf])).toBe(false);
  });
});

describe('computeAllRollups', () => {
  it('returns rollup map for all summary tasks', () => {
    const root = makeTask({ id: 'root' });
    const parentA = makeTask({ id: 'A', parentId: 'root', duration: 5, progress: 50 });
    const parentB = makeTask({ id: 'B', parentId: 'root', duration: 3, progress: 100 });
    const childA1 = makeTask({ id: 'A1', parentId: 'A', duration: 5, progress: 50 });
    const childB1 = makeTask({ id: 'B1', parentId: 'B', duration: 3, progress: 100 });

    const tasks = [root, parentA, parentB, childA1, childB1];
    const rollupMap = computeAllRollups(tasks);

    // root, A, B are all summaries
    expect(rollupMap.has('root')).toBe(true);
    expect(rollupMap.has('A')).toBe(true);
    expect(rollupMap.has('B')).toBe(true);

    // A's rollup: single child A1 → progress=50
    expect(rollupMap.get('A')!.progress).toBe(50);
    // B's rollup: single child B1 → progress=100
    expect(rollupMap.get('B')!.progress).toBe(100);
    // root's rollup: children A(dur=5,prog=50) and B(dur=3,prog=100)
    // weighted: (50*5 + 100*3) / 8 = 69
    expect(rollupMap.get('root')!.progress).toBe(69);
    // Duration: sum of direct children
    expect(rollupMap.get('root')!.duration).toBe(8);
  });
});
