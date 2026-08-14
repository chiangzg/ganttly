import { describe, expect, it } from 'vitest';
import { createDefaultTask, createEmptyFile } from '@ganttly/schema';
import type { GanttlyFile } from '@ganttly/schema';
import { getTaskDetail, searchTasksInFile } from '../../../src/modules/projects/read';

function buildFile(): GanttlyFile {
  const file = createEmptyFile({ name: 'MCP read tests' });
  const root = createDefaultTask({
    id: 'root',
    name: 'Root',
    start: '2026-01-01',
    parentId: null,
    order: 0,
  });
  const design = createDefaultTask({
    id: 'design',
    name: 'Design API',
    start: '2026-01-02',
    parentId: 'root',
    order: 0,
  });
  design.progress = 50;
  design.note = 'draft spec';
  const build = createDefaultTask({
    id: 'build',
    name: 'Build API',
    start: '2026-01-05',
    parentId: 'root',
    order: 1,
  });
  build.progress = 10;
  build.dependencies = [{ targetId: 'design', type: 'FS', lag: 0 }];
  const test_ = createDefaultTask({
    id: 'test',
    name: 'Test',
    start: '2026-01-10',
    parentId: null,
    order: 1,
  });
  test_.progress = 100;
  test_.assignments = [{ resourceId: 'r1', load: 80 }];
  return { ...file, tasks: [root, design, build, test_] };
}

describe('searchTasksInFile', () => {
  const file = buildFile();

  it('returns all tasks sorted by order when no filter is given', () => {
    const { tasks } = searchTasksInFile(file, { limit: 50 });
    expect(tasks.map((t) => t.id)).toEqual(['root', 'design', 'build', 'test']);
  });

  it('filters by case-insensitive name substring', () => {
    const { tasks } = searchTasksInFile(file, { name: 'api', limit: 50 });
    expect(tasks.map((t) => t.id)).toEqual(['design', 'build']);
  });

  it('filters by note substring', () => {
    const { tasks } = searchTasksInFile(file, { note: 'spec', limit: 50 });
    expect(tasks.map((t) => t.id)).toEqual(['design']);
  });

  it('filters by parentTaskId', () => {
    const { tasks } = searchTasksInFile(file, { parentTaskId: 'root', limit: 50 });
    expect(tasks.map((t) => t.id)).toEqual(['design', 'build']);
  });

  it('filters by progress range', () => {
    const { tasks } = searchTasksInFile(file, { progressMin: 50, limit: 50 });
    expect(tasks.map((t) => t.id)).toEqual(['design', 'test']);
  });

  it('filters by start date range', () => {
    const { tasks } = searchTasksInFile(file, { startFrom: '2026-01-05', limit: 50 });
    expect(tasks.map((t) => t.id)).toEqual(['build', 'test']);
  });

  it('filters by assignee resource', () => {
    const { tasks } = searchTasksInFile(file, { assigneeResourceId: 'r1', limit: 50 });
    expect(tasks.map((t) => t.id)).toEqual(['test']);
  });

  it('paginates with a cursor and limit', () => {
    const page1 = searchTasksInFile(file, { limit: 2 });
    expect(page1.tasks.map((t) => t.id)).toEqual(['root', 'design']);
    expect(page1.nextCursor).toBe('design');
    const page2 = searchTasksInFile(file, { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.tasks.map((t) => t.id)).toEqual(['build', 'test']);
    expect(page2.nextCursor).toBeNull();
  });

  it('returns an empty page when nothing matches', () => {
    const { tasks, nextCursor } = searchTasksInFile(file, { name: 'nope', limit: 50 });
    expect(tasks).toEqual([]);
    expect(nextCursor).toBeNull();
  });
});

describe('getTaskDetail', () => {
  const file = buildFile();

  it('returns null for an unknown task', () => {
    expect(getTaskDetail(file, 'missing')).toBeNull();
  });

  it('returns the full task with parent, predecessors and children', () => {
    const detail = getTaskDetail(file, 'build')!;
    expect(detail.task.id).toBe('build');
    expect(detail.parent?.id).toBe('root');
    expect(detail.predecessors.map((p) => p.id)).toEqual(['design']);
    expect(detail.children).toEqual([]);
  });

  it('lists direct children for a parent task', () => {
    const detail = getTaskDetail(file, 'root')!;
    expect(detail.children.map((c) => c.id)).toEqual(['design', 'build']);
    expect(detail.parent).toBeNull();
  });
});
