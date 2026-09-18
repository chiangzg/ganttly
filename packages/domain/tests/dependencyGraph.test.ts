import { describe, expect, it } from 'vitest';
import { computeDependencyClosure } from '../src/dependencyGraph';
import type { Task, Dependency } from '@ganttly/schema';

function task(id: string, deps: Dependency[] = [], parentId: string | null = null): Task {
  return {
    id,
    name: id,
    parentId,
    order: 0,
    start: '2026-01-05',
    end: '2026-01-09',
    duration: 5,
    progress: 0,
    isMilestone: false,
    dependencies: deps,
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
  };
}

const dep = (targetId: string): Dependency => ({ targetId, type: 'FS', lag: 0 });

describe('computeDependencyClosure — direction & transitivity', () => {
  it('linear chain A → B → C from B: upstream={A}, downstream={C}', () => {
    const tasks = [task('a'), task('b', [dep('a')]), task('c', [dep('b')])];
    const r = computeDependencyClosure(tasks, 'b')!;
    expect(r.originId).toBe('b');
    expect([...r.upstream.entries()]).toEqual([['a', 1]]);
    expect([...r.downstream.entries()]).toEqual([['c', 1]]);
  });

  it('transitive closure with BFS depths (stagger input)', () => {
    // a → b → origin → c → d → e, plus a → f (depth 2 via b)
    const tasks = [
      task('a'),
      task('b', [dep('a')]),
      task('origin', [dep('b')]),
      task('c', [dep('origin')]),
      task('d', [dep('c')]),
      task('e', [dep('d')]),
      task('f', [dep('a')]),
    ];
    const r = computeDependencyClosure(tasks, 'origin')!;
    expect(r.upstream.get('b')).toBe(1);
    expect(r.upstream.get('a')).toBe(2);
    expect(r.downstream.get('c')).toBe(1);
    expect(r.downstream.get('d')).toBe(2);
    expect(r.downstream.get('e')).toBe(3);
    // f is NOT reachable from origin in either direction
    expect(r.upstream.has('f')).toBe(false);
    expect(r.downstream.has('f')).toBe(false);
  });

  it('diamond: shortest depth wins regardless of edge order', () => {
    // a → b → d, a → c → d; from a both b/c are depth 1, d is depth 2
    const tasks = [
      task('a'),
      task('b', [dep('a')]),
      task('c', [dep('a')]),
      task('d', [dep('c'), dep('b')]),
    ];
    const r = computeDependencyClosure(tasks, 'a')!;
    expect(r.downstream.get('b')).toBe(1);
    expect(r.downstream.get('c')).toBe(1);
    expect(r.downstream.get('d')).toBe(2);
  });

  it('origin with no dependencies has empty maps', () => {
    const r = computeDependencyClosure([task('a'), task('b')], 'a')!;
    expect(r.upstream.size).toBe(0);
    expect(r.downstream.size).toBe(0);
  });
});

describe('computeDependencyClosure — robustness', () => {
  it('unknown origin id returns null', () => {
    expect(computeDependencyClosure([task('a')], 'nope')).toBeNull();
  });

  it('missing targetId references are skipped', () => {
    const tasks = [task('a', [dep('ghost')]), task('b', [dep('a')])];
    const r = computeDependencyClosure(tasks, 'a')!;
    expect(r.upstream.size).toBe(0); // ghost ignored
    expect(r.downstream.get('b')).toBe(1);
  });

  it('existing-data cycle terminates and stays finite', () => {
    // b → origin, c → b, and a legacy cycle c → d → c (d unreachable from origin)
    const tasks = [
      task('origin'),
      task('b', [dep('origin')]),
      task('c', [dep('b'), dep('d')]),
      task('d', [dep('c')]),
    ];
    const r = computeDependencyClosure(tasks, 'origin')!;
    expect(r.downstream.get('b')).toBe(1);
    expect(r.downstream.get('c')).toBe(2);
    // d is reachable via c → d despite the c/d cycle: BFS terminates.
    expect(r.downstream.get('d')).toBe(3);
    expect(r.downstream.size).toBe(3);
  });

  it('cycle back into the origin does not leak the origin into the maps', () => {
    // origin → b → origin (legacy cycle through the origin itself)
    const tasks = [task('origin'), task('b', [dep('origin')])];
    const r = computeDependencyClosure(tasks, 'origin')!;
    expect(r.downstream.has('b')).toBe(true);
    expect(r.downstream.has('origin')).toBe(false);
  });

  it('summary tasks participate (raw graph, not leaf-only CPM)', () => {
    // legacy edge touching a summary must still highlight
    const tasks = [
      task('summary', [], null),
      task('child', [], 'summary'),
      task('origin', [dep('summary')]),
    ];
    const r = computeDependencyClosure(tasks, 'origin')!;
    expect(r.upstream.has('summary')).toBe(true);
  });

  it('self-loop dependency is ignored', () => {
    const tasks = [task('a', [dep('a')]), task('b', [dep('a')])];
    const r = computeDependencyClosure(tasks, 'a')!;
    expect(r.upstream.size).toBe(0);
    expect(r.downstream.get('b')).toBe(1);
  });
});
