import { describe, expect, it } from 'vitest';
import { applyDragWithRollup } from '@/engine/interaction';
import { resolveCalendar } from '@/lib/calendar';
import { createDefaultTask, type Calendar, type Task } from '@ganttly/schema';

/**
 * Drag-commit duration must be derived in WORKING days from the dragged span
 * (schema: "Duration in WORKING days"), not calendar days. Regression guard
 * for the bug where a drag across the National Day holiday wrote the natural
 * day count (9/28–10/8 → 11) instead of the working-day count (4).
 */
const cal = resolveCalendar({
  id: 'test',
  weekStart: 1,
  weekends: [0, 6],
  holidays: [
    ...[
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ].map((date) => ({ date, name: '国庆', type: 'holiday' as const })),
    // 调休补班: a Sunday that counts as a working day.
    { date: '2026-09-20', name: '调休补班', type: 'working' as const },
  ],
  workingHours: { start: '09:00', end: '18:00' },
} satisfies Calendar);

function makeTask(
  id: string,
  start: string,
  end: string,
  duration: number,
  overrides: Partial<Task> = {},
): Task {
  const base = createDefaultTask({ id, name: id, start, parentId: null, order: 0 });
  return { ...base, end, duration, ...overrides };
}

describe('applyDragWithRollup — duration in working days', () => {
  it('derives working-day duration from the dragged span (9/28–10/8 across 国庆 → 4, not 11)', () => {
    const leaf = makeTask('leaf', '2026-09-28', '2026-10-08', 11);
    const next = applyDragWithRollup(
      [leaf],
      'leaf',
      { start: '2026-09-28', end: '2026-10-08' },
      cal,
    );
    expect(next[0]!.start).toBe('2026-09-28');
    expect(next[0]!.end).toBe('2026-10-08');
    expect(next[0]!.duration).toBe(4);
  });

  it('floors at 1 when the whole span is the holiday week', () => {
    const leaf = makeTask('leaf', '2026-10-01', '2026-10-03', 1);
    const next = applyDragWithRollup(
      [leaf],
      'leaf',
      { start: '2026-10-01', end: '2026-10-03' },
      cal,
    );
    expect(next[0]!.duration).toBe(1);
  });

  it('floors at 1 for a weekend-only span', () => {
    const leaf = makeTask('leaf', '2026-09-26', '2026-09-27', 2);
    const next = applyDragWithRollup(
      [leaf],
      'leaf',
      { start: '2026-09-26', end: '2026-09-27' },
      cal,
    );
    expect(next[0]!.duration).toBe(1);
  });

  it('counts 调休补班 as a working day (9/18 Fri + 9/20 Sunday make-up → 2)', () => {
    const leaf = makeTask('leaf', '2026-09-18', '2026-09-20', 3);
    const next = applyDragWithRollup(
      [leaf],
      'leaf',
      { start: '2026-09-18', end: '2026-09-20' },
      cal,
    );
    expect(next[0]!.duration).toBe(2);
  });

  it('keeps the stored duration for milestones', () => {
    const ms = makeTask('ms', '2026-10-01', '2026-10-01', 1, { isMilestone: true });
    const next = applyDragWithRollup([ms], 'ms', { start: '2026-10-01', end: '2026-10-01' }, cal);
    expect(next[0]!.duration).toBe(1);
  });

  it('cascades the working-day duration into ancestor summaries', () => {
    const parent = makeTask('parent', '2026-09-28', '2026-10-08', 11);
    const child = makeTask('child', '2026-09-28', '2026-10-08', 11, {
      parentId: 'parent',
      order: 0,
    });
    const sibling = makeTask('sibling', '2026-11-02', '2026-11-03', 2, {
      parentId: 'parent',
      order: 1,
    });
    const next = applyDragWithRollup(
      [parent, child, sibling],
      'child',
      { start: '2026-09-28', end: '2026-10-08' },
      cal,
    );
    const dragged = next.find((t) => t.id === 'child')!;
    expect(dragged.duration).toBe(4);
    const summary = next.find((t) => t.id === 'parent')!;
    expect(summary.duration).toBe(6); // 4 (child, working days) + 2 (sibling)
    expect(summary.start).toBe('2026-09-28');
    expect(summary.end).toBe('2026-11-03');
  });
});
