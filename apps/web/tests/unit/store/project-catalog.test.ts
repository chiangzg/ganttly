import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBRepository } from '@/data/indexeddb';
import { EMPTY_PROJECT_NAVIGATION } from '@/data/repository';
import { useProjectCatalogStore } from '@/store/useProjectCatalogStore';
import { addTaskCommand, useProjectStore } from '@/store/useProjectStore';
import type { Task } from '@ganttly/schema';

let repo: IndexedDBRepository;

beforeEach(async () => {
  repo = new IndexedDBRepository();
  for (const project of await repo.listProjects({ includeDeleted: true })) {
    await repo.deleteProjectPermanently(project.id);
  }
  await repo.saveNavigationState(structuredClone(EMPTY_PROJECT_NAVIGATION));
  useProjectStore.getState().unloadProject();
  useProjectCatalogStore.setState({
    repo: null,
    projects: [],
    trash: [],
    navigation: structuredClone(EMPTY_PROJECT_NAVIGATION),
    status: 'idle',
    error: null,
    preferenceError: null,
  });
  await useProjectCatalogStore.getState().init(repo);
});

describe('project catalog lifecycle', () => {
  it('keeps task data isolated while switching projects', async () => {
    const catalog = useProjectCatalogStore.getState();
    const projectA = await catalog.createProject('Project A');
    expect(await useProjectCatalogStore.getState().activateProject(projectA)).toBe(true);

    useProjectStore.getState().dispatch(addTaskCommand(makeTask('a-task'), null, 0));
    await useProjectStore.getState().flushPendingSave();

    const projectB = await useProjectCatalogStore.getState().createProject('Project B');
    expect(await useProjectCatalogStore.getState().activateProject(projectB)).toBe(true);
    expect(useProjectStore.getState().file.tasks).toHaveLength(0);

    expect(await useProjectCatalogStore.getState().activateProject(projectA)).toBe(true);
    expect(useProjectStore.getState().file.tasks.map((task) => task.id)).toEqual(['a-task']);
    expect(useProjectStore.getState().undoStack).toHaveLength(0);
  });

  it('duplicates content and supports trash restore', async () => {
    const original = await useProjectCatalogStore.getState().createProject('Original');
    await useProjectCatalogStore.getState().activateProject(original);
    useProjectStore.getState().dispatch(addTaskCommand(makeTask('copied-task'), null, 0));
    await useProjectStore.getState().flushPendingSave();

    const duplicate = await useProjectCatalogStore.getState().duplicateProject(original);
    await useProjectCatalogStore.getState().activateProject(duplicate);
    expect(useProjectStore.getState().file.project.name).toBe('Original 副本');
    expect(useProjectStore.getState().file.tasks.map((task) => task.id)).toContain('copied-task');

    await useProjectCatalogStore.getState().moveToTrash(duplicate);
    expect(useProjectCatalogStore.getState().trash.map((project) => project.id)).toContain(
      duplicate,
    );
    expect(useProjectCatalogStore.getState().projects.map((project) => project.id)).not.toContain(
      duplicate,
    );

    await useProjectCatalogStore.getState().restoreProject(duplicate);
    expect(useProjectCatalogStore.getState().projects.map((project) => project.id)).toContain(
      duplicate,
    );
  });

  it('persists favorites, open tabs and pin state', async () => {
    const id = await useProjectCatalogStore.getState().createProject('Pinned');
    await useProjectCatalogStore.getState().activateProject(id);
    useProjectCatalogStore.getState().toggleFavorite(id);
    useProjectCatalogStore.getState().togglePinned(id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const saved = await repo.loadNavigationState();
    expect(saved.favoriteProjectIds).toContain(id);
    expect(saved.openTabs).toContainEqual({ projectId: id, pinned: true });
    expect(saved.lastActiveProjectId).toBe(id);
  });
});

function makeTask(id: string): Task {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-07-24',
    end: '2026-07-24',
    duration: 1,
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
  };
}
