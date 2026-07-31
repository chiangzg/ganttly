import { describe, expect, it, beforeEach } from 'vitest';
import {
  computeRevealTarget,
  clampScrollTop,
  visibleRowIndex,
  type RevealViewport,
} from '@/lib/revealTask';
import { useViewStore } from '@/store/useViewStore';
import { createEmptyFile, createDefaultTask, type GanttlyFile, type Task } from '@ganttly/schema';
import { ROW_HEIGHT, HEADER_HEIGHT, dateToPixel, pixelsPerDay } from '@/engine/layout';

/**
 * Build a minimal file fixture. The default `createEmptyFile` starts at zoom
 * `week`; tests override per-scenario.
 */
function makeFile(tasks: Task[], overrides: Partial<GanttlyFile> = {}): GanttlyFile {
  return {
    ...createEmptyFile({ name: 'test' }),
    tasks,
    ...overrides,
  };
}

function makeTask(id: string, start: string, overrides: Partial<Task> = {}): Task {
  return createDefaultTask({
    id,
    name: id,
    start,
    parentId: null,
    order: 0,
    ...overrides,
  });
}

const VIEWPORT: RevealViewport = { width: 800, height: 600 };

beforeEach(() => {
  // Reset the ephemeral view store so activeBaselineId is null between tests.
  useViewStore.getState().setActiveBaselineId(null);
});

describe('computeRevealTarget — existence', () => {
  it('returns null when the task does not exist', () => {
    const file = makeFile([makeTask('a', '2026-01-05', { order: 0 })]);
    expect(computeRevealTarget(file, 'missing', VIEWPORT)).toBeNull();
  });
});

describe('computeRevealTarget — horizontal reveal', () => {
  it('centers a far-future task into the viewport', () => {
    // Origin ~ 2026-01-05; task at 2026-07-31 is ~207 days away.
    const file = makeFile([makeTask('a', '2026-01-05', { order: 0 })], {
      project: { name: 't', locale: 'zh-CN', startDate: '2026-01-05' },
    });
    file.tasks[0]!.start = '2026-07-31';
    file.tasks[0]!.end = '2026-07-31';
    const target = computeRevealTarget(file, 'a', VIEWPORT)!;
    expect(target.scrollLeft).not.toBeNull();
    const barPx = dateToPixel('2026-07-31', '2026-01-05', file.viewState.zoom);
    // After reveal, the bar center must land inside [0, viewportWidth].
    const barCenter = barPx + pixelsPerDay(file.viewState.zoom) / 2;
    const revealed = barCenter - target.scrollLeft!;
    expect(revealed).toBeGreaterThanOrEqual(0);
    expect(revealed).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('does NOT move the view when the bar is already fully visible', () => {
    const file = makeFile([makeTask('a', '2026-01-05', { order: 0 })], {
      project: { name: 't', locale: 'zh-CN', startDate: '2026-01-05' },
      viewState: {
        zoom: 'week',
        scrollLeft: 0,
        scrollTop: 0,
        selectedTaskId: null,
        showCriticalPath: false,
        collapsedTaskIds: [],
      },
    });
    // Bar at origin, scrollLeft 0, 800px viewport → fully visible.
    const target = computeRevealTarget(file, 'a', VIEWPORT)!;
    expect(target.scrollLeft).toBeNull();
  });

  it('scrolls left when the bar is to the right of the viewport', () => {
    const file = makeFile([makeTask('a', '2026-01-05', { order: 0 })], {
      project: { name: 't', locale: 'zh-CN', startDate: '2026-01-05' },
      // Bar at pixel 0, but scrolled so far right that 0 is off-screen left.
      viewState: {
        zoom: 'day',
        scrollLeft: 5000,
        scrollTop: 0,
        selectedTaskId: null,
        showCriticalPath: false,
        collapsedTaskIds: [],
      },
    });
    const target = computeRevealTarget(file, 'a', VIEWPORT)!;
    expect(target.scrollLeft).not.toBeNull();
    expect(target.scrollLeft!).toBeLessThan(5000);
  });

  it('clamps scrollLeft to >= 0 (never negative)', () => {
    const file = makeFile([makeTask('a', '2026-01-05', { order: 0 })], {
      project: { name: 't', locale: 'zh-CN', startDate: '2026-01-05' },
    });
    const target = computeRevealTarget(file, 'a', VIEWPORT)!;
    if (target.scrollLeft !== null) {
      expect(target.scrollLeft).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('computeRevealTarget — vertical reveal', () => {
  it('scrolls down to a task many rows below', () => {
    // 100 tasks; task at row 80 is far below a 600px viewport (~17 rows).
    const tasks: Task[] = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(makeTask(`t${i}`, '2026-01-05', { order: i }));
    }
    const file = makeFile(tasks);
    const target = computeRevealTarget(file, 't80', VIEWPORT)!;
    expect(target.scrollTop).not.toBeNull();
    // Row 80 top = 80 * ROW_HEIGHT; the chosen scrollTop must bring it below
    // the header and into view.
    const rowTop = 80 * ROW_HEIGHT;
    expect(target.scrollTop!).toBeLessThanOrEqual(rowTop);
  });

  it('does NOT move vertically when the row is already visible', () => {
    const tasks: Task[] = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(makeTask(`t${i}`, '2026-01-05', { order: i }));
    }
    const file = makeFile(tasks, {
      viewState: {
        zoom: 'week',
        scrollLeft: 0,
        scrollTop: 0,
        selectedTaskId: null,
        showCriticalPath: false,
        collapsedTaskIds: [],
      },
    });
    // 5 rows fit easily in 600px → no vertical scroll needed.
    const target = computeRevealTarget(file, 't2', VIEWPORT)!;
    expect(target.scrollTop).toBeNull();
  });

  it('keeps the revealed row below the header', () => {
    const tasks: Task[] = [];
    for (let i = 0; i < 50; i++) {
      tasks.push(makeTask(`t${i}`, '2026-01-05', { order: i }));
    }
    const file = makeFile(tasks);
    const target = computeRevealTarget(file, 't40', VIEWPORT)!;
    expect(target.scrollTop).not.toBeNull();
    const rowTop = 40 * ROW_HEIGHT;
    const rowViewTop = rowTop - target.scrollTop!;
    // Row must render below the header band in the canvas.
    expect(rowViewTop).toBeGreaterThanOrEqual(HEADER_HEIGHT - 1);
  });
});

describe('computeRevealTarget — ancestor expansion', () => {
  it('lists collapsed ancestors that must be expanded', () => {
    // Parent collapsed → child hidden from the flat list.
    const parent = makeTask('parent', '2026-01-05', { order: 0 });
    const child = makeTask('child', '2026-01-06', { parentId: 'parent', order: 0 });
    const file = makeFile([parent, child], {
      viewState: {
        zoom: 'week',
        scrollLeft: 0,
        scrollTop: 0,
        selectedTaskId: null,
        showCriticalPath: false,
        collapsedTaskIds: ['parent'],
      },
    });
    const target = computeRevealTarget(file, 'child', VIEWPORT)!;
    expect(target.ancestorsToExpand).toContain('parent');
  });

  it('finds the row index using the expanded set (row becomes visible)', () => {
    const parent = makeTask('parent', '2026-01-05', { order: 0 });
    const child = makeTask('child', '2026-01-06', { parentId: 'parent', order: 0 });
    const file = makeFile([parent, child], {
      viewState: {
        zoom: 'week',
        scrollLeft: 0,
        scrollTop: 0,
        selectedTaskId: null,
        showCriticalPath: false,
        collapsedTaskIds: ['parent'],
      },
    });
    const target = computeRevealTarget(file, 'child', VIEWPORT)!;
    // With the ancestor expansion applied, the child's row index is 1.
    expect(target.scrollTop).not.toBeNull(); // some vertical scroll computed
  });

  it('does not expand ancestors when expandAncestors is false', () => {
    const parent = makeTask('parent', '2026-01-05', { order: 0 });
    const child = makeTask('child', '2026-01-06', { parentId: 'parent', order: 0 });
    const file = makeFile([parent, child], {
      viewState: {
        zoom: 'week',
        scrollLeft: 0,
        scrollTop: 0,
        selectedTaskId: null,
        showCriticalPath: false,
        collapsedTaskIds: ['parent'],
      },
    });
    const target = computeRevealTarget(file, 'child', VIEWPORT, {
      expandAncestors: false,
    })!;
    expect(target.ancestorsToExpand).toEqual([]);
  });
});

describe('clampScrollTop', () => {
  it('clamps to [0, max]', () => {
    // 10 rows * 32px = 320px content; 600px viewport → max = 0.
    expect(clampScrollTop(100, 10, 600)).toBe(0);
    // 100 rows * 32px = 3200px; 600px viewport → max = 2600.
    expect(clampScrollTop(9999, 100, 600)).toBe(2600);
    expect(clampScrollTop(-5, 100, 600)).toBe(0);
  });
});

describe('visibleRowIndex', () => {
  it('returns -1 when the task is hidden by a collapsed ancestor', () => {
    const parent = makeTask('parent', '2026-01-05', { order: 0 });
    const child = makeTask('child', '2026-01-06', { parentId: 'parent', order: 0 });
    const file = makeFile([parent, child], {
      viewState: {
        zoom: 'week',
        scrollLeft: 0,
        scrollTop: 0,
        selectedTaskId: null,
        showCriticalPath: false,
        collapsedTaskIds: ['parent'],
      },
    });
    expect(visibleRowIndex(file, 'child')).toBe(-1);
  });

  it('returns the flat index when visible', () => {
    const tasks = [
      makeTask('a', '2026-01-05', { order: 0 }),
      makeTask('b', '2026-01-06', { order: 1 }),
    ];
    const file = makeFile(tasks);
    expect(visibleRowIndex(file, 'b')).toBe(1);
  });
});
