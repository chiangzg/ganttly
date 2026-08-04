import { describe, expect, it, beforeEach } from 'vitest';
import {
  computeFilteredRows,
  buildFilterPredicate,
  matchesSearch,
  matchesSearchTask,
  isSearchActive,
  isFilterActive,
  isAnyFilterActive,
  type TaskFilter,
} from '@/lib/taskFilter';
import { useViewStore } from '@/store/useViewStore';
import { createEmptyFile, createDefaultTask, type GanttlyFile, type Task } from '@ganttly/schema';
import { todayISO } from '@/engine/layout';
import { addCalendarDays } from '@/lib/calendar';

function makeFile(tasks: Task[], overrides: Partial<GanttlyFile> = {}): GanttlyFile {
  return { ...createEmptyFile({ name: 'test' }), tasks, ...overrides };
}

/**
 * Build a leaf task with explicit end (default factory sets end = start).
 *
 * NOTE: `createDefaultTask` builds a fixed object and does NOT spread the
 * options we pass for `progress` / `assignments` / `dependencies` — so we layer
 * those on afterwards. (The factory only honours id/name/start/parentId/order.)
 */
function makeTask(id: string, start: string, overrides: Partial<Task> = {}): Task {
  const t = createDefaultTask({ id, name: id, start, parentId: null, order: 0 });
  return { ...t, ...overrides };
}

/** Parent + child helper: parent has no assignments/progress; child is a leaf. */
function makeParentWithChild(
  parentId: string,
  childId: string,
  childStart: string,
  childOverrides: Partial<Task> = {},
): { parent: Task; child: Task } {
  const parent = makeTask(parentId, childStart, { order: 0 });
  const child = makeTask(childId, childStart, {
    parentId,
    order: 0,
    ...childOverrides,
  });
  return { parent, child };
}

beforeEach(() => {
  // These are pure-function tests — computeFilteredRows takes query/filter as
  // args, so we only reset the baseline id (used by origin/CPM indirectly).
  useViewStore.getState().setActiveBaselineId(null);
});

describe('isSearchActive / isFilterActive / isAnyFilterActive', () => {
  it('treats whitespace-only queries as inactive', () => {
    expect(isSearchActive('')).toBe(false);
    expect(isSearchActive('   ')).toBe(false);
    expect(isSearchActive('x')).toBe(true);
  });

  it('treats "none" filter as inactive', () => {
    expect(isFilterActive('none')).toBe(false);
    expect(isFilterActive('unassigned')).toBe(true);
  });

  it('isAnyFilterActive is true when either is active', () => {
    expect(isAnyFilterActive('', 'none')).toBe(false);
    expect(isAnyFilterActive('x', 'none')).toBe(true);
    expect(isAnyFilterActive('', 'overdue')).toBe(true);
  });
});

describe('matchesSearch', () => {
  const file = makeFile([makeTask('a', '2026-01-05', { name: '开发实现', order: 0 })]);
  // buildTree fills wbsNumber; reuse computeFilteredRows to get a node with WBS.
  const { rows } = computeFilteredRows(file, '', 'none');
  const node = rows[0]!;

  it('matches case-insensitively against the name', () => {
    expect(matchesSearch(node.task, node, '开发')).toBe(true);
    expect(matchesSearch(node.task, node, 'DEV')).toBe(false); // name is Chinese
  });

  it('matches against the WBS number', () => {
    expect(matchesSearch(node.task, node, '1')).toBe(true); // WBS "1"
  });

  it('returns true for an empty query', () => {
    expect(matchesSearch(node.task, node, '')).toBe(true);
  });

  it('matchesSearchTask is name-only', () => {
    expect(matchesSearchTask(node.task, '开发')).toBe(true);
    expect(matchesSearchTask(node.task, 'nope')).toBe(false);
  });
});

describe('computeFilteredRows — no filter active (zero-regression path)', () => {
  it('returns flattenVisible over the persisted collapse state with null override', () => {
    const { parent, child } = makeParentWithChild('p', 'c', '2026-01-05');
    const file = makeFile([parent, child], {
      viewState: {
        zoom: 'week',
        scrollLeft: 0,
        scrollTop: 0,
        selectedTaskId: null,
        showCriticalPath: false,
        collapsedTaskIds: ['p'], // parent collapsed → child hidden
      },
    });
    const { rows, expandedOverride } = computeFilteredRows(file, '', 'none');
    expect(expandedOverride).toBeNull();
    expect(rows.map((n) => n.task.id)).toEqual(['p']); // child hidden
  });
});

describe('computeFilteredRows — search', () => {
  it('finds a task hidden under a collapsed parent and force-expands ancestors', () => {
    const { parent, child } = makeParentWithChild('p', 'c', '2026-01-05');
    (child as Task).name = 'hidden-child';
    const file = makeFile([parent, child], {
      viewState: {
        zoom: 'week',
        scrollLeft: 0,
        scrollTop: 0,
        selectedTaskId: null,
        showCriticalPath: false,
        collapsedTaskIds: ['p'],
      },
    });
    const { rows, expandedOverride } = computeFilteredRows(file, 'hidden', 'none');
    // The child is now visible AND the parent appears as context.
    expect(rows.map((n) => n.task.id)).toEqual(['p', 'c']);
    // Override drops the parent from the collapsed set.
    expect(expandedOverride).not.toBeNull();
    expect(expandedOverride!.has('p')).toBe(false);
  });

  it('returns an empty rows list when nothing matches', () => {
    const file = makeFile([makeTask('a', '2026-01-05', { name: 'alpha', order: 0 })]);
    const { rows } = computeFilteredRows(file, 'zzz', 'none');
    expect(rows).toEqual([]);
  });

  it('matches by WBS number', () => {
    const { parent, child } = makeParentWithChild('p', 'c', '2026-01-05');
    const file = makeFile([parent, child]); // WBS: p=1, c=1.1
    const { rows } = computeFilteredRows(file, '1.1', 'none');
    expect(rows.map((n) => n.task.id)).toContain('c');
    // Parent shown as context.
    expect(rows.map((n) => n.task.id)).toContain('p');
  });
});

describe('buildFilterPredicate — unassigned', () => {
  it('matches leaf tasks with no assignments, excludes summaries and assigned', () => {
    const { parent, child } = makeParentWithChild('p', 'c', '2026-01-05');
    const assigned = makeTask('asg', '2026-01-05', { order: 1 });
    // createDefaultTask ignores the assignments option (it hardcodes []), so
    // add the assignment directly on the task object.
    assigned.assignments = [{ resourceId: 'r1', load: 100 }];
    const file = makeFile([parent, child, assigned]);
    const pred = buildFilterPredicate(file, 'unassigned')!;
    expect(pred).not.toBeNull();
    // child (leaf, unassigned) → true
    expect(pred(child)).toBe(true);
    // assigned leaf → false
    expect(pred(assigned)).toBe(false);
    // parent (summary) → false
    expect(pred(parent)).toBe(false);
  });
});

describe('buildFilterPredicate — criticalPath', () => {
  it('matches zero-float leaves (a predecessor–successor chain is fully critical)', () => {
    // A→B chain, both 1 day, FS dependency. CPM: both end up with float 0
    // because B is pinned to A's finish and A is pinned to the project start —
    // the whole chain is the critical path. An unrelated parallel task C with
    // slack should NOT match.
    const a = makeTask('a', '2026-01-05', { order: 0 });
    const b = makeTask('b', '2026-01-06', { order: 1 });
    b.dependencies = [{ targetId: 'a', type: 'FS', lag: 0 }];
    const file = makeFile([a, b]);
    const pred = buildFilterPredicate(file, 'criticalPath')!;
    expect(pred(a)).toBe(true);
    expect(pred(b)).toBe(true);
  });
});

describe('buildFilterPredicate — overdue', () => {
  it('matches leaves whose end is before today and progress < 100', () => {
    const today = todayISO();
    const pastEnd = addCalendarDays(today, -10);
    const overdue = makeTask('od', pastEnd, { order: 0, progress: 30 });
    const done = makeTask('dn', pastEnd, { order: 1, progress: 100 });
    const future = makeTask('ft', addCalendarDays(today, 10), { order: 2, progress: 30 });
    const file = makeFile([overdue, done, future]);
    const pred = buildFilterPredicate(file, 'overdue')!;
    expect(pred(overdue)).toBe(true);
    expect(pred(done)).toBe(false); // completed
    expect(pred(future)).toBe(false); // not past end
  });

  it('excludes summary tasks even when their span is in the past', () => {
    const today = todayISO();
    const past = addCalendarDays(today, -10);
    const { parent, child } = makeParentWithChild('p', 'c', past, { progress: 30 });
    const file = makeFile([parent, child]);
    const pred = buildFilterPredicate(file, 'overdue')!;
    expect(pred(parent)).toBe(false);
    expect(pred(child)).toBe(true);
  });
});

describe('computeFilteredRows — filter + search combined', () => {
  it('applies both the search term and the filter predicate (AND)', () => {
    const today = todayISO();
    const past = addCalendarDays(today, -10);
    // Two overdue tasks, only one matches the search term.
    const a = makeTask('alpha-overdue', past, { order: 0, progress: 10 });
    const b = makeTask('beta-overdue', past, { order: 1, progress: 10 });
    const file = makeFile([a, b]);
    const { rows } = computeFilteredRows(file, 'alpha', 'overdue');
    expect(rows.map((n) => n.task.id)).toEqual(['alpha-overdue']);
  });
});

describe('computeFilteredRows — filter clears override when inactive', () => {
  it('returns null override once the filter is cleared', () => {
    const today = todayISO();
    const past = addCalendarDays(today, -10);
    const a = makeTask('a', past, { order: 0, progress: 10 });
    const file = makeFile([a]);
    // Active filter → override set.
    const active = computeFilteredRows(file, '', 'overdue');
    expect(active.expandedOverride).not.toBeNull();
    // Cleared → null (original path).
    const cleared = computeFilteredRows(file, '', 'none' as TaskFilter);
    expect(cleared.expandedOverride).toBeNull();
  });
});
