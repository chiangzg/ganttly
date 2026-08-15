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
      duplicate.projectId,
    );
    expect(useProjectCatalogStore.getState().projects.map((project) => project.id)).not.toContain(
      duplicate.projectId,
    );

    await useProjectCatalogStore.getState().restoreProject(duplicate);
    expect(useProjectCatalogStore.getState().projects.map((project) => project.id)).toContain(
      duplicate.projectId,
    );
  });

  it('persists favorites, open tabs and pin state', async () => {
    const ref = await useProjectCatalogStore.getState().createProject('Pinned');
    await useProjectCatalogStore.getState().activateProject(ref);
    useProjectCatalogStore.getState().toggleFavorite(ref);
    useProjectCatalogStore.getState().togglePinned(ref);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const saved = await repo.loadNavigationState();
    expect(saved.favoriteRefs).toContainEqual(ref);
    expect(saved.openTabs).toContainEqual({ ref, pinned: true });
    expect(saved.lastActiveRef).toEqual(ref);
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

describe('remote ref handling (scope-aware resolution)', () => {
  const REMOTE = { instanceId: 'inst_x', workspaceId: 'ws_1', projectId: 'prj_1' };

  it('renameProject on a remote ref fails cleanly when not authenticated', async () => {
    // No instance/auth registered → repository resolution must fail with the
    // standard message instead of falling back to the local IndexedDB repo.
    await expect(
      useProjectCatalogStore.getState().renameProject(REMOTE, 'New name'),
    ).rejects.toThrow('工作区未登录或不可用');
  });

  it('moveToTrash on a remote ref fails cleanly when not authenticated', async () => {
    await expect(useProjectCatalogStore.getState().moveToTrash(REMOTE)).rejects.toThrow(
      '工作区未登录或不可用',
    );
    // The local repo must not have been touched.
    expect(await repo.listProjects({ includeDeleted: true })).toHaveLength(0);
  });

  it('closeTab falls back to a ref in the active (remote) scope, not local', async () => {
    const { useScopeStore } = await import('@/store/useScopeStore');
    useScopeStore.setState({ activeScope: { instanceId: 'inst_x', workspaceId: 'ws_1' } });
    useProjectCatalogStore.setState({
      projects: [
        {
          id: 'prj_1',
          name: 'R1',
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
        },
        {
          id: 'prj_2',
          name: 'R2',
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
        },
      ],
    });
    const remoteTab = { instanceId: 'inst_x', workspaceId: 'ws_1', projectId: 'prj_1' };
    useProjectCatalogStore.getState().togglePinned(remoteTab);
    useProjectStore.setState({ activeProjectRef: remoteTab });

    const next = useProjectCatalogStore.getState().closeTab(remoteTab);
    // Falls back to the other project in the same remote scope — never a
    // local ref wrapping a remote id.
    expect(next).toEqual({ instanceId: 'inst_x', workspaceId: 'ws_1', projectId: 'prj_2' });
  });
});

describe('boot race (refresh before init)', () => {
  it('a refresh racing ahead of init cannot starve initialization', async () => {
    // Fresh page load: ProjectCenter's refresh effect flushes before App's
    // init effect (child passive effects run first), so refresh sees no repo.
    useProjectCatalogStore.setState({ repo: null, status: 'idle', error: null });
    await useProjectCatalogStore.getState().refresh();
    expect(useProjectCatalogStore.getState().status).toBe('error');

    // App's init guard keys off the repository, not `status === 'idle'`,
    // so init still runs and clears the transient error.
    await useProjectCatalogStore.getState().init(repo);
    expect(useProjectCatalogStore.getState().status).toBe('ready');
    expect(useProjectCatalogStore.getState().error).toBeNull();
    expect(useProjectCatalogStore.getState().repo).toBe(repo);
  });
});
