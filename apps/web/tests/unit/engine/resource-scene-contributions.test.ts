/**
 * Hover-tooltip contribution index parity (G13).
 *
 * `assembleResourceScene` precomputes the per-resource, per-date contributing-
 * task index used by the resource-view hover tooltip. Summary tasks must be
 * excluded from it: a task assigned while it was still a leaf keeps a stale
 * assignment after children are indented beneath it, and listing the summary
 * as a "contributor" would contradict the load bars (which skip summaries —
 * see computeResourceLoad) and re-introduce the double-count visually.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultTask, createEmptyFile, type GanttlyFile, type Task } from '@ganttly/schema';
import { assembleResourceScene } from '@/engine/scene';

function makeFile(tasks: Task[]): GanttlyFile {
  const file = createEmptyFile({ name: 'contrib-test' });
  return {
    ...file,
    tasks,
    resources: [{ id: 'r1', name: '邓纳多', capacity: 1 }],
  };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  // createDefaultTask only reads its declared options (id/name/start/parentId/
  // order) — spread overrides on top so `end`/`assignments` are not dropped.
  return {
    ...createDefaultTask({
      id,
      name: id,
      start: '2026-08-17',
      parentId: null,
      order: 0,
    }),
    ...overrides,
  };
}

function assemble(file: GanttlyFile) {
  return assembleResourceScene(file, {
    viewportWidth: 800,
    viewportHeight: 600,
    today: '2026-08-19',
    scrollTop: 0,
    selectedResourceId: null,
  });
}

describe('assembleResourceScene — contributions exclude summary tasks', () => {
  it('does not list a summary with a stale assignment as a contributing task', () => {
    // The reported bug's shape: parent "财务中台需求开发" was assigned 邓纳多@100%
    // as a leaf, then children (same assignee) were indented beneath it.
    const file = makeFile([
      makeTask('parent', { end: '2026-08-21', assignments: [{ resourceId: 'r1', load: 100 }] }),
      makeTask('c1', {
        parentId: 'parent',
        order: 0,
        end: '2026-08-19',
        assignments: [{ resourceId: 'r1', load: 100 }],
      }),
      makeTask('c2', {
        parentId: 'parent',
        order: 1,
        start: '2026-08-20',
        end: '2026-08-21',
        assignments: [{ resourceId: 'r1', load: 50 }],
      }),
    ]);

    const scene = assemble(file);
    const resourceRow = scene.rows.find((r) => r.kind === 'resource' && r.id === 'r1');
    expect(resourceRow).toBeDefined();

    const bars = resourceRow!.kind === 'resource' ? resourceRow!.bars : [];
    expect(bars.length).toBeGreaterThan(0);

    // Every bar's load must come from children only: c1 gives 100 on 08-17..19,
    // c2 gives 50 on 08-20..21 — never the +100 the stale parent would add.
    const loadByDate = new Map(bars.map((b) => [b.date, b.load]));
    expect(loadByDate.get('2026-08-17')).toBe(100);
    expect(loadByDate.get('2026-08-20')).toBe(50);

    // The tooltip's contributing-task lists must not mention the summary.
    for (const bar of bars) {
      expect((bar.contributions ?? []).map((c) => c.taskId)).not.toContain('parent');
    }
  });
});
