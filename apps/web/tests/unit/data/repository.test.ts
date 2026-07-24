import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBRepository } from '@/data/indexeddb';
import { LocalStorageRepository } from '@/data/localstorage';
import { createEmptyFile } from '@ganttly/schema';
import type { GanttlyFile, Task } from '@ganttly/schema';
import type { DataRepository } from '@/data/repository';
import { RevisionConflictError, summarizeProject } from '@/data/repository';

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
  let repo: DataRepository;
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

  it('supports project snapshots, revisions and soft delete', async () => {
    const created = await repo.createProject({ id: 'multi-a', file: makeFile('A') });
    expect(created.revision).toBe('1');
    expect((await repo.listProjects()).map((item) => item.id)).toContain('multi-a');

    const updated = { ...created.file, project: { ...created.file.project, name: 'A updated' } };
    const saved = await repo.saveProject('multi-a', updated, { expectedRevision: '1' });
    expect(saved.revision).toBe('2');
    expect((await repo.loadProject('multi-a'))?.summary.name).toBe('A updated');

    await expect(
      repo.saveProject('multi-a', updated, { expectedRevision: '1' }),
    ).rejects.toBeInstanceOf(RevisionConflictError);

    await repo.moveToTrash('multi-a');
    expect(await repo.listProjects()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'multi-a' })]),
    );
    expect((await repo.listProjects({ includeDeleted: true })).map((item) => item.id)).toContain(
      'multi-a',
    );
    await repo.restoreProject('multi-a');
    expect((await repo.listProjects()).map((item) => item.id)).toContain('multi-a');
    await repo.deleteProjectPermanently('multi-a');
    expect(await repo.loadProject('multi-a')).toBeNull();
  });

  it('persists navigation preferences separately from project files', async () => {
    await repo.createProject({ id: 'multi-b', file: makeFile('B') });
    const navigation = {
      lastActiveProjectId: 'multi-b',
      openTabs: [{ projectId: 'multi-b', pinned: true }],
      favoriteProjectIds: ['multi-b'],
      recentProjects: [{ projectId: 'multi-b', lastOpenedAt: '2026-07-24T00:00:00.000Z' }],
    };
    await repo.saveNavigationState(navigation);
    expect(await repo.loadNavigationState()).toEqual(navigation);
    expect((await repo.loadProject('multi-b'))?.file.project.name).toBe('B');
  });
});

describe('summarizeProject', () => {
  it('weights leaf task progress by duration and excludes summary tasks', () => {
    const file = makeFile('summary');
    file.tasks = [
      { ...file.tasks[0]!, id: 'parent', name: 'Parent', duration: 10, progress: 0 },
      {
        ...file.tasks[0]!,
        id: 'short',
        parentId: 'parent',
        duration: 1,
        progress: 100,
        start: '2026-01-05',
        end: '2026-01-05',
      },
      {
        ...file.tasks[0]!,
        id: 'long',
        parentId: 'parent',
        duration: 3,
        progress: 0,
        start: '2026-01-06',
        end: '2026-01-08',
      },
    ];
    const summary = summarizeProject('summary', file);
    expect(summary.taskCount).toBe(2);
    expect(summary.completedTaskCount).toBe(1);
    expect(summary.progress).toBe(25);
  });
});
