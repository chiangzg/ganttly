/**
 * Unit tests for clipboard + sibling-reorder commands (PRD §3.10, F.1/F.3).
 *
 * Covers:
 * - swapSiblingOrderCommand (Alt+Up/Down): swaps order, undo restores both.
 * - pasteTaskCommand (Ctrl+V): inserts copy as next sibling, bumps later
 *   siblings, undo removes it and restores orders.
 */
import { describe, it, expect } from 'vitest';
import type { GanttlyFile, Task } from '@ganttly/schema';
import { swapSiblingOrderCommand, pasteTaskCommand } from '@/store/useProjectStore';

function task(id: string, parentId: string | null, order: number): Task {
  return {
    id,
    name: id,
    parentId,
    order,
    start: '2026-02-02',
    end: '2026-02-06',
    duration: 5,
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: {},
    assignments: [],
    customFields: {},
  };
}

function file(tasks: Task[]): GanttlyFile {
  return {
    schemaVersion: 1,
    project: { name: 't', locale: 'zh-CN' },
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

describe('swapSiblingOrderCommand', () => {
  it('swaps the order of two siblings', () => {
    const f = file([task('A', null, 0), task('B', null, 1), task('C', null, 2)]);
    const cmd = swapSiblingOrderCommand('A', 'B');
    const next = cmd.apply(f);
    const a = next.tasks.find((t) => t.id === 'A')!;
    const b = next.tasks.find((t) => t.id === 'B')!;
    expect(a.order).toBe(1); // A took B's slot
    expect(b.order).toBe(0); // B took A's slot
    // C untouched.
    expect(next.tasks.find((t) => t.id === 'C')!.order).toBe(2);
  });

  it('invert restores both orders', () => {
    const f = file([task('A', null, 0), task('B', null, 1)]);
    const cmd = swapSiblingOrderCommand('A', 'B');
    const applied = cmd.apply(f);
    const restored = cmd.invert(applied);
    expect(restored.tasks.find((t) => t.id === 'A')!.order).toBe(0);
    expect(restored.tasks.find((t) => t.id === 'B')!.order).toBe(1);
  });

  it('is a no-op forward if either id is missing', () => {
    const f = file([task('A', null, 0)]);
    const cmd = swapSiblingOrderCommand('A', 'MISSING');
    expect(cmd.apply(f)).toBe(f);
  });
});

describe('pasteTaskCommand', () => {
  it('inserts template as the next sibling of the anchor and bumps later siblings', () => {
    const f = file([task('A', null, 0), task('B', null, 1), task('C', null, 2)]);
    const template = { ...task('PASTE1', null, 0), name: 'Pasted' };
    const cmd = pasteTaskCommand(template, 'A');
    const next = cmd.apply(f);

    const pasted = next.tasks.find((t) => t.id === 'PASTE1')!;
    expect(pasted.parentId).toBeNull();
    expect(pasted.order).toBe(1); // right after A
    // B and C bumped by 1.
    expect(next.tasks.find((t) => t.id === 'B')!.order).toBe(2);
    expect(next.tasks.find((t) => t.id === 'C')!.order).toBe(3);
    // A untouched.
    expect(next.tasks.find((t) => t.id === 'A')!.order).toBe(0);
    expect(next.tasks.length).toBe(4);
  });

  it('invert removes the pasted task and restores sibling orders', () => {
    const f = file([task('A', null, 0), task('B', null, 1)]);
    const template = { ...task('PASTE1', null, 0), name: 'Pasted' };
    const cmd = pasteTaskCommand(template, 'A');
    const applied = cmd.apply(f);
    const restored = cmd.invert(applied);

    expect(restored.tasks.find((t) => t.id === 'PASTE1')).toBeUndefined();
    expect(restored.tasks.find((t) => t.id === 'A')!.order).toBe(0);
    expect(restored.tasks.find((t) => t.id === 'B')!.order).toBe(1);
  });

  it('is a no-op forward if the anchor is missing', () => {
    const f = file([task('A', null, 0)]);
    const template = { ...task('PASTE1', null, 0) };
    const cmd = pasteTaskCommand(template, 'MISSING');
    expect(cmd.apply(f)).toBe(f);
  });
});
