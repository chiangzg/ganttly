import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { useProjectStore, updateTaskCommand, type Command } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { setTaskPriority } from '@/lib/setTaskPriority';
import type { Task } from '@ganttly/schema';
import { setRepository } from '@/data/createRepository';
import { IndexedDBRepository } from '@/data/indexeddb';

/**
 * The one write path for "priority changed outside the drawer" (matrix drag,
 * context menu) — priority-matrix spec §3.2, §4.5, §4.8.
 */

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
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

function seed(tasks: Task[]) {
  const noop: Command = {
    label: 'seed',
    apply: (file) => ({ ...file, tasks }),
    invert: (file) => file,
  };
  useProjectStore.getState().dispatch(noop);
  useProjectStore.setState({ undoStack: [], redoStack: [] });
}

const priorityOf = (id: string) =>
  useProjectStore.getState().file.tasks.find((t) => t.id === id)!.priority;
const undoCount = () => useProjectStore.getState().undoStack.length;

describe('setTaskPriority', () => {
  beforeEach(async () => {
    const repo = new IndexedDBRepository();
    for (const m of await repo.listProjects()) await repo.deleteProject(m.id);
    setRepository(repo);
    await useProjectStore.getState().init(repo);
    useProjectStore.setState({ undoStack: [], redoStack: [] });
    useViewStore.setState({ prioritySyncRequest: null });
  });

  it('sets and clears a priority with exactly one undo record each', () => {
    seed([makeTask('t1')]);

    expect(setTaskPriority('t1', 2)).toBe(true);
    expect(priorityOf('t1')).toBe(2);
    expect(undoCount()).toBe(1);

    expect(setTaskPriority('t1', undefined)).toBe(true);
    expect(priorityOf('t1')).toBeUndefined();
    expect(undoCount()).toBe(2);

    useProjectStore.getState().undo();
    expect(priorityOf('t1')).toBe(2);
  });

  it('dispatches nothing when the priority is already the requested one', () => {
    seed([makeTask('t1', { priority: 3 })]);
    // A plain update WOULD pollute the undo stack — the helper must not.
    useProjectStore.getState().dispatch(updateTaskCommand('t1', { priority: 3 }));
    const polluted = undoCount();
    useProjectStore.setState({ undoStack: [] });

    expect(setTaskPriority('t1', 3)).toBe(false);
    expect(setTaskPriority('missing', 1)).toBe(false);
    expect(undoCount()).toBe(0);
    expect(polluted).toBe(1);
  });

  it('asks an open drawer to re-base its draft (spec §4.8)', () => {
    seed([makeTask('t1')]);
    useViewStore.setState({ prioritySyncRequest: null });

    setTaskPriority('t1', 1);
    expect(useViewStore.getState().prioritySyncRequest?.taskId).toBe('t1');

    // A no-op must not ping the drawer for nothing.
    useViewStore.setState({ prioritySyncRequest: null });
    setTaskPriority('t1', 1);
    expect(useViewStore.getState().prioritySyncRequest).toBeNull();
  });

  it('does not touch dates: a priority change never reschedules anything', () => {
    const task = makeTask('t1', { start: '2026-02-02', end: '2026-02-06' });
    seed([task]);
    setTaskPriority('t1', 4);
    const saved = useProjectStore.getState().file.tasks[0]!;
    expect(saved.start).toBe(task.start);
    expect(saved.end).toBe(task.end);
    expect(saved.duration).toBe(task.duration);
  });

  it('uses spy to prove the same command the drawer would dispatch', () => {
    // Guards the "no rollup" choice: a priority edit must go through the plain
    // update command, not the rollup/cascade one.
    seed([makeTask('t1')]);
    const spy = vi.spyOn(useProjectStore.getState(), 'dispatch');
    setTaskPriority('t1', 2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].label).toBe('更新任务');
    spy.mockRestore();
  });
});
