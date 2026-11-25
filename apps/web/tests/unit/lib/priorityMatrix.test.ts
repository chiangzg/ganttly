import { describe, expect, it } from 'vitest';
import { createDefaultTask, createEmptyFile } from '@ganttly/schema';
import type { GanttlyFile, Task } from '@ganttly/schema';
import { resolveCalendar } from '@/lib/calendar';
import {
  DEFAULT_MATRIX_SORT,
  DUE_SOON_WORKING_DAYS,
  bucketMatrixTasks,
  compareMatrixCards,
  compareWbs,
  dueHint,
  matrixVisibleIds,
  resolvePriorityDrop,
} from '@/lib/priorityMatrix';
import type { MatrixCard, MatrixFilters } from '@/lib/priorityMatrix';

/**
 * Pure core of the priority matrix (priority-matrix spec §2, §4).
 *
 * TODAY is a Wednesday, so "due soon" cases can cross a weekend on purpose:
 * the hint counts WORKING days, not calendar days.
 */
const TODAY = '2026-03-04';
const CAL = resolveCalendar(createEmptyFile().calendar);

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    ...createDefaultTask({ id, name: id, start: '2026-03-02', parentId: null, order: 0 }),
    end: '2026-03-06',
    duration: 5,
    ...overrides,
  };
}

function makeFile(tasks: Task[]): GanttlyFile {
  return { ...createEmptyFile({ name: 'matrix' }), tasks };
}

const filters = (overrides: Partial<MatrixFilters> = {}): MatrixFilters => ({
  searchQuery: '',
  assignee: 'all',
  showDone: false,
  sort: DEFAULT_MATRIX_SORT,
  ...overrides,
});

const ids = (cards: MatrixCard[]) => cards.map((card) => card.task.id);

describe('dueHint (spec §2.2)', () => {
  it('reports a completed task as done, whatever its dates', () => {
    expect(dueHint(makeTask('t', { progress: 100, end: '2026-01-01' }), TODAY, CAL)).toEqual({
      kind: 'done',
    });
  });

  it('counts overdue in calendar days', () => {
    expect(dueHint(makeTask('t', { end: '2026-03-01' }), TODAY, CAL)).toEqual({
      kind: 'overdue',
      days: 3,
    });
    expect(dueHint(makeTask('t', { end: '2026-03-03' }), TODAY, CAL)).toEqual({
      kind: 'overdue',
      days: 1,
    });
  });

  it('flags a task due today, and one due within the next working days', () => {
    expect(dueHint(makeTask('t', { end: TODAY }), TODAY, CAL)).toEqual({
      kind: 'dueSoon',
      workingDays: 0,
    });
    // Wed → Thu: 1 working day after today.
    expect(dueHint(makeTask('t', { end: '2026-03-05' }), TODAY, CAL)).toEqual({
      kind: 'dueSoon',
      workingDays: 1,
    });
    // Wed → Fri: Thu, Fri = 2.
    expect(dueHint(makeTask('t', { end: '2026-03-06' }), TODAY, CAL)).toEqual({
      kind: 'dueSoon',
      workingDays: 2,
    });
    // Across a weekend: Thu, Fri, Mon = 3 working days — still due soon.
    expect(dueHint(makeTask('t', { end: '2026-03-09' }), TODAY, CAL)).toEqual({
      kind: 'dueSoon',
      workingDays: DUE_SOON_WORKING_DAYS,
    });
  });

  it('treats "today" on a weekend as due today, not due in N days', () => {
    // 2026-03-07 is a Saturday; a task ending that day is due today.
    expect(dueHint(makeTask('t', { end: '2026-03-07' }), '2026-03-07', CAL)).toEqual({
      kind: 'dueSoon',
      workingDays: 0,
    });
    // Saturday → Monday is a single working day away.
    expect(dueHint(makeTask('t', { end: '2026-03-09' }), '2026-03-07', CAL)).toEqual({
      kind: 'dueSoon',
      workingDays: 1,
    });
  });

  it('returns no hint once the task is further out than the window', () => {
    // Thu, Fri, Mon, Tue = 4 working days.
    expect(dueHint(makeTask('t', { end: '2026-03-10' }), TODAY, CAL)).toEqual({ kind: 'none' });
    expect(dueHint(makeTask('t', { end: '2026-04-01' }), TODAY, CAL)).toEqual({ kind: 'none' });
  });
});

describe('compareWbs', () => {
  it('orders numerically, not as text', () => {
    expect(compareWbs('1.10', '1.2')).toBeGreaterThan(0);
    expect(compareWbs('1.2', '1.10')).toBeLessThan(0);
    expect(compareWbs('2', '1.9')).toBeGreaterThan(0);
    expect(compareWbs('1.1', '1.1')).toBe(0);
    expect(compareWbs('', '1')).toBeLessThan(0);
  });
});

describe('compareMatrixCards (spec §4.3)', () => {
  const card = (id: string, overrides: Partial<Task>, wbsNumber = id): MatrixCard => ({
    task: makeTask(id, overrides),
    wbsNumber,
  });

  it('default: overdue first, then by end date, then by WBS', () => {
    const cards = [
      card('later', { end: '2026-03-20' }, '1.1'),
      card('sooner', { end: '2026-03-10' }, '1.2'),
      card('overdue', { end: '2026-03-01' }, '1.3'),
      card('tie', { end: '2026-03-10' }, '1.1'),
    ];
    const sorted = [...cards].sort((a, b) => compareMatrixCards(a, b, 'default', TODAY));
    expect(ids(sorted)).toEqual(['overdue', 'tie', 'sooner', 'later']);
  });

  it('supports the explicit sort modes', () => {
    const a = card('a', { start: '2026-03-02', end: '2026-03-10', progress: 60 }, '1.1');
    const b = card('b', { start: '2026-03-05', end: '2026-03-06', progress: 10 }, '1.2');
    expect(compareMatrixCards(a, b, 'end', TODAY)).toBeGreaterThan(0);
    expect(compareMatrixCards(a, b, 'start', TODAY)).toBeLessThan(0);
    expect(compareMatrixCards(a, b, 'progress', TODAY)).toBeGreaterThan(0);
    // WBS mode ignores dates entirely.
    expect(compareMatrixCards(a, b, 'wbs', TODAY)).toBeLessThan(0);
  });

  it('always sinks completed tasks to the end', () => {
    const done = card('done', { progress: 100, end: '2026-03-01' }, '1.1');
    const open = card('open', { end: '2026-03-31' }, '9.9');
    expect(compareMatrixCards(done, open, 'default', TODAY)).toBeGreaterThan(0);
    expect(compareMatrixCards(done, open, 'wbs', TODAY)).toBeGreaterThan(0);
  });
});

describe('bucketMatrixTasks (spec §2.3, §4.3)', () => {
  it('puts leaves and milestones in buckets and never a summary', () => {
    const file = makeFile([
      makeTask('summary', { priority: 1 }),
      makeTask('p1', { parentId: 'summary', priority: 1 }),
      makeTask('p4', { parentId: 'summary', priority: 4 }),
      makeTask('milestone', { parentId: 'summary', isMilestone: true, priority: 2, duration: 0 }),
      makeTask('untriaged', { parentId: 'summary' }),
    ]);
    const model = bucketMatrixTasks(file, filters(), TODAY);

    expect(ids(model.tray)).toEqual(['untriaged']);
    expect(ids(model.quadrants[1])).toEqual(['p1']);
    expect(ids(model.quadrants[2])).toEqual(['milestone']);
    expect(ids(model.quadrants[4])).toEqual(['p4']);
    expect(model.leafTotal).toBe(4);
    expect(model.isFiltered).toBe(false);
  });

  it('carries the WBS number and keeps the tray in WBS order', () => {
    const tasks: Task[] = [makeTask('parent', { order: 0 })];
    for (let i = 1; i <= 10; i++) {
      tasks.push(makeTask(`c${i}`, { parentId: 'parent', order: i - 1 }));
    }
    tasks.push(makeTask('root', { order: 1 }));
    const model = bucketMatrixTasks(makeFile(tasks), filters(), TODAY);

    // A text sort would file "1.10" between "1.1" and "1.2".
    expect(model.tray.map((card) => card.wbsNumber)).toEqual([
      '1.1',
      '1.2',
      '1.3',
      '1.4',
      '1.5',
      '1.6',
      '1.7',
      '1.8',
      '1.9',
      '1.10',
      '2',
    ]);
  });

  it('treats an out-of-range priority as not triaged instead of crashing', () => {
    // Data that bypassed normalizeFile: an out-of-range value must read as
    // "not triaged", not index a bucket that does not exist.
    const bad = { ...makeTask('bad'), priority: 7 } as unknown as Task;
    const model = bucketMatrixTasks(makeFile([bad]), filters(), TODAY);
    expect(ids(model.tray)).toEqual(['bad']);
  });

  it('hides completed tasks unless showDone is on, then sorts them last', () => {
    const file = makeFile([
      makeTask('done', { priority: 1, progress: 100, end: '2026-01-01' }),
      makeTask('open', { priority: 1, end: '2026-03-20' }),
      makeTask('doneUntriaged', { progress: 100 }),
    ]);
    const hidden = bucketMatrixTasks(file, filters(), TODAY);
    expect(hidden.quadrants[1].map((c) => c.task.id)).toEqual(['open']);
    expect(hidden.tray).toEqual([]);
    // leafTotal counts every leaf regardless of filters.
    expect(hidden.leafTotal).toBe(3);

    const shown = bucketMatrixTasks(file, filters({ showDone: true }), TODAY);
    expect(ids(shown.quadrants[1])).toEqual(['open', 'done']);
    expect(ids(shown.tray)).toEqual(['doneUntriaged']);
    // Showing completed tasks is not a "filter" for the summary line.
    expect(shown.isFiltered).toBe(false);
  });

  it('filters by assignee: all / unassigned / a specific resource', () => {
    const file = makeFile([
      makeTask('wang', { assignments: [{ resourceId: 'wang', load: 50 }] }),
      makeTask('li', { assignments: [{ resourceId: 'li', load: 50 }] }),
      makeTask('none', {}),
    ]);
    expect(ids(bucketMatrixTasks(file, filters({ assignee: 'none' }), TODAY).tray)).toEqual([
      'none',
    ]);
    expect(ids(bucketMatrixTasks(file, filters({ assignee: 'wang' }), TODAY).tray)).toEqual([
      'wang',
    ]);
    expect(bucketMatrixTasks(file, filters({ assignee: 'wang' }), TODAY).isFiltered).toBe(true);
  });

  it('filters by the shared search box: task name or WBS number', () => {
    const file = makeFile([
      makeTask('a', { name: '发布评审', order: 0 }),
      makeTask('b', { name: '接口联调', parentId: 'a' }),
      makeTask('c', { name: '其他', order: 1 }),
    ]);
    expect(ids(bucketMatrixTasks(file, filters({ searchQuery: '接口' }), TODAY).tray)).toEqual([
      'b',
    ]);
    // "1.1" is b's WBS number (a is root 1, b its only child).
    expect(ids(bucketMatrixTasks(file, filters({ searchQuery: '1.1' }), TODAY).tray)).toEqual([
      'b',
    ]);
    expect(bucketMatrixTasks(file, filters({ searchQuery: '  ' }), TODAY).isFiltered).toBe(false);
  });

  it('applies each quadrant its own sort', () => {
    const file = makeFile([
      makeTask('late', { priority: 3, start: '2026-03-01', end: '2026-03-30' }),
      makeTask('early', { priority: 3, start: '2026-03-03', end: '2026-03-05' }),
      makeTask('x', { priority: 4, end: '2026-03-05', progress: 90 }),
      makeTask('y', { priority: 4, end: '2026-03-30' }),
    ]);
    const model = bucketMatrixTasks(
      file,
      filters({ sort: { ...DEFAULT_MATRIX_SORT, 3: 'start' } }),
      TODAY,
    );
    // P3 sorts by start date: `late` starts first even though it ends last.
    expect(ids(model.quadrants[3])).toEqual(['late', 'early']);
    // P4 keeps the default (end date ascending): the due-soon task comes first.
    expect(ids(model.quadrants[4])).toEqual(['x', 'y']);
  });
});

describe('matrixVisibleIds', () => {
  it('lists cards in reading order: tray first, then P1 → P4', () => {
    const file = makeFile([
      makeTask('q4', { priority: 4 }),
      makeTask('q1', { priority: 1 }),
      makeTask('tray', {}),
      makeTask('q2', { priority: 2 }),
    ]);
    const model = bucketMatrixTasks(file, filters(), TODAY);
    expect(matrixVisibleIds(model)).toEqual(['tray', 'q1', 'q2', 'q4']);
  });
});

describe('resolvePriorityDrop (spec §4.5)', () => {
  it('maps a bucket to the priority it means', () => {
    expect(resolvePriorityDrop(2, makeTask('t'))).toEqual({ priority: 2, changed: true });
    expect(resolvePriorityDrop('tray', makeTask('t', { priority: 1 }))).toEqual({
      priority: undefined,
      changed: true,
    });
  });

  it('reports no change when the task is already in that bucket', () => {
    expect(resolvePriorityDrop(3, makeTask('t', { priority: 3 })).changed).toBe(false);
    expect(resolvePriorityDrop('tray', makeTask('t')).changed).toBe(false);
    // After a clear the in-memory key holds `undefined` — still "in the tray".
    expect(resolvePriorityDrop('tray', makeTask('t', { priority: undefined })).changed).toBe(false);
  });
});
