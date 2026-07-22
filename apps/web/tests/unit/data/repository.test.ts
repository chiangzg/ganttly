import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBRepository } from '@/data/indexeddb';
import { LocalStorageRepository } from '@/data/localstorage';
import { createEmptyFile } from '@ganttly/schema';
import type { GanttlyFile, Task } from '@ganttly/schema';
import type { ProjectRepository } from '@/data/repository';

function makeFile(name: string): GanttlyFile {
  const file = createEmptyFile({ name });
  const task: Task = {
    id: 't1',
    name: 'First task',
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
  };
  file.tasks = [task];
  return file;
}

describe.each([
  ['IndexedDBRepository', () => new IndexedDBRepository()],
  ['LocalStorageRepository', () => new LocalStorageRepository()],
])('%s', (_name, makeRepo) => {
  let repo: ProjectRepository;
  beforeEach(async () => {
    repo = makeRepo();
    // Clear whichever backend this implementation uses.
    if (repo instanceof LocalStorageRepository) {
      localStorage.clear();
    } else {
      // IndexedDBRepository — clear via the public list+delete API.
      for (const m of await repo.listProjects()) {
        await repo.deleteProject(m.id);
      }
    }
  });

  it('returns null when project does not exist', async () => {
    expect(await repo.load('missing')).toBeNull();
  });

  it('saves and loads a project', async () => {
    const file = makeFile('My project');
    await repo.save('p1', file);
    const loaded = await repo.load('p1');
    expect(loaded?.project.name).toBe('My project');
    expect(loaded?.tasks).toHaveLength(1);
    expect(loaded?.tasks[0]?.name).toBe('First task');
  });

  it('overwrites on save', async () => {
    const file = makeFile('v1');
    await repo.save('p1', file);
    const updated = { ...file, project: { ...file.project, name: 'v2' } };
    await repo.save('p1', updated);
    const loaded = await repo.load('p1');
    expect(loaded?.project.name).toBe('v2');
  });

  it('lists projects sorted by updatedAt desc', async () => {
    const a = makeFile('a');
    a.meta.updatedAt = '2026-01-01T00:00:00Z';
    const b = makeFile('b');
    b.meta.updatedAt = '2026-02-01T00:00:00Z';
    await repo.save('a', a);
    await repo.save('b', b);
    const list = await repo.listProjects();
    expect(list.map((m) => m.id)).toEqual(['b', 'a']);
    expect(list.map((m) => m.name)).toEqual(['b', 'a']);
  });

  it('deletes a project', async () => {
    await repo.save('p1', makeFile('x'));
    await repo.deleteProject('p1');
    expect(await repo.load('p1')).toBeNull();
  });

  it('delete is a no-op for missing project', async () => {
    await expect(repo.deleteProject('nope')).resolves.toBeUndefined();
  });
});
