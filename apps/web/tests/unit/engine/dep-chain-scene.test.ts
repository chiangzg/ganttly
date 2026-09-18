/**
 * Dependency-chain scene assembly tests (dependency-chain spec §5.1/§7).
 *
 * Verifies that `assembleScene` derives `Scene.depChain` from the selection
 * (single-selection only) and marks each arrow's `chainRole` by the
 * induced-subgraph rule, plus ancestor-summary collection for the spotlight.
 */
import { describe, expect, it } from 'vitest';
import { assembleScene } from '@/engine/scene';
import { createEmptyFile, createDefaultTask, type GanttlyFile, type Task } from '@ganttly/schema';

function makeFile(tasks: Task[]): GanttlyFile {
  return { ...createEmptyFile({ name: 'test' }), tasks };
}

function makeTask(id: string, start: string, overrides: Partial<Task> = {}): Task {
  const t = createDefaultTask({ id, name: id, start, parentId: null, order: 0 });
  return { ...t, ...overrides };
}

const OPTS = {
  viewportWidth: 1200,
  viewportHeight: 600,
  today: '2026-07-01',
};

// a → origin → c, plus an unrelated island x → y. July 2026.
function chainFile(): GanttlyFile {
  return makeFile([
    makeTask('a', '2026-07-01'),
    makeTask('origin', '2026-07-08', {
      dependencies: [{ targetId: 'a', type: 'FS', lag: 0 }],
    }),
    makeTask('c', '2026-07-15', {
      dependencies: [{ targetId: 'origin', type: 'FS', lag: 0 }],
    }),
    makeTask('x', '2026-07-01'),
    makeTask('y', '2026-07-08', {
      dependencies: [{ targetId: 'x', type: 'FS', lag: 0 }],
    }),
  ]);
}

describe('assembleScene — depChain derivation', () => {
  it('single selection activates the chain with correct closures', () => {
    const scene = assembleScene(chainFile(), { ...OPTS, selectedTaskIds: new Set(['origin']) });
    expect(scene.depChain).toBeDefined();
    expect(scene.depChain!.originId).toBe('origin');
    expect([...scene.depChain!.upstream.keys()]).toEqual(['a']);
    expect([...scene.depChain!.downstream.keys()]).toEqual(['c']);
  });

  it('multi-selection never shows a chain', () => {
    const scene = assembleScene(chainFile(), {
      ...OPTS,
      selectedTaskIds: new Set(['origin', 'c']),
    });
    expect(scene.depChain).toBeUndefined();
    // And without any selection either.
    expect(assembleScene(chainFile(), OPTS).depChain).toBeUndefined();
  });

  it('stale selectedTaskId in viewState does NOT activate the chain alone', () => {
    // viewState.selectedTaskId survives reloads while the ephemeral selection
    // set does not — the chain must key off the SET, not the mirrored id.
    const file = chainFile();
    file.viewState.selectedTaskId = 'origin';
    const scene = assembleScene(file, OPTS);
    expect(scene.depChain).toBeUndefined();
  });

  it('marks arrow chainRole by induced-subgraph membership', () => {
    const scene = assembleScene(chainFile(), { ...OPTS, selectedTaskIds: new Set(['origin']) });
    const roleOf = (fromId: string, toId: string) =>
      scene.arrows.find((a) => a.fromId === fromId && a.toId === toId)?.chainRole;
    expect(roleOf('a', 'origin')).toBe('upstream');
    expect(roleOf('origin', 'c')).toBe('downstream');
    expect(roleOf('x', 'y')).toBeUndefined();
  });

  it('collects ancestor summaries of chain members for the spotlight', () => {
    // S(parent) > { a, origin }, origin selected → S must stay full-opacity.
    const file = makeFile([
      makeTask('S', '2026-07-01'),
      makeTask('a', '2026-07-01', { parentId: 'S' }),
      makeTask('origin', '2026-07-08', {
        parentId: 'S',
        dependencies: [{ targetId: 'a', type: 'FS', lag: 0 }],
      }),
    ]);
    const scene = assembleScene(file, { ...OPTS, selectedTaskIds: new Set(['origin']) });
    expect(scene.depChain!.relatedSummaryIds.has('S')).toBe(true);
  });

  it('deep chains carry BFS depths for the pulse stagger', () => {
    const file = makeFile([
      makeTask('a', '2026-07-01'),
      makeTask('b', '2026-07-08', { dependencies: [{ targetId: 'a', type: 'FS', lag: 0 }] }),
      makeTask('origin', '2026-07-15', { dependencies: [{ targetId: 'b', type: 'FS', lag: 0 }] }),
      makeTask('d', '2026-07-22', { dependencies: [{ targetId: 'origin', type: 'FS', lag: 0 }] }),
      makeTask('e', '2026-07-29', { dependencies: [{ targetId: 'd', type: 'FS', lag: 0 }] }),
    ]);
    const scene = assembleScene(file, { ...OPTS, selectedTaskIds: new Set(['origin']) });
    expect(scene.depChain!.upstream.get('b')).toBe(1);
    expect(scene.depChain!.upstream.get('a')).toBe(2);
    expect(scene.depChain!.downstream.get('d')).toBe(1);
    expect(scene.depChain!.downstream.get('e')).toBe(2);
  });
});
