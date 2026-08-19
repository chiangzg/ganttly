/**
 * Stale-refresh guard in the catalog store (spec §12.3 scope switching).
 *
 * ProjectCenter fires a refresh per scope change without cancelling the
 * previous one. When the user leaves a remote scope, the in-flight remote
 * list request is slower than the follow-up local IndexedDB read; without a
 * guard its (now stale) response lands last and wipes the local grid — the
 * "switched back to local and the list is empty until page reload" bug.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBRepository } from '@/data/indexeddb';
import { EMPTY_PROJECT_NAVIGATION, type ProjectRepository } from '@/data/repository';
import { resolveProjectRepository } from '@/data/resolveRepository';
import { useProjectCatalogStore } from '@/store/useProjectCatalogStore';
import { useProjectStore } from '@/store/useProjectStore';
import { useScopeStore } from '@/store/useScopeStore';
import { useAuthStore } from '@/store/useAuthStore';
import { localScope } from '@/data/projectRef';

vi.mock('@/data/resolveRepository', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveProjectRepository: vi.fn() };
});

let repo: IndexedDBRepository;

beforeEach(async () => {
  vi.mocked(resolveProjectRepository).mockReset();
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
  useScopeStore.setState({ activeScope: localScope() });
  useAuthStore.setState({ authByInstance: {} });
  await useProjectCatalogStore.getState().init(repo);
});

/** A remote repository whose list response is held back until released. */
function slowRemoteRepo() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = {
    listProjects: () => pending.then(() => []),
  } as unknown as ProjectRepository;
  return { fake, release };
}

describe('refresh scope-switch race', () => {
  it('discards a stale remote response that lands after switching back to local', async () => {
    await useProjectCatalogStore.getState().createProject('Local One');
    expect(useProjectCatalogStore.getState().projects).toHaveLength(1);

    const { fake, release } = slowRemoteRepo();
    vi.mocked(resolveProjectRepository).mockReturnValue(fake);
    useAuthStore.setState({
      authByInstance: { official: { userId: 'u1', displayName: 'Dev User' } },
    });
    useScopeStore.setState({ activeScope: { instanceId: 'official', workspaceId: 'ws_r' } });

    // Refresh under the remote scope — the response is held in flight.
    const staleRefresh = useProjectCatalogStore.getState().refresh();

    // User switches back to local; the local refresh resolves immediately.
    await useScopeStore.getState().switchScope(localScope());
    await useProjectCatalogStore.getState().refresh();
    expect(useProjectCatalogStore.getState().projects).toHaveLength(1);

    // The stale remote response arrives last and must be dropped.
    release();
    await staleRefresh;
    expect(useProjectCatalogStore.getState().projects).toHaveLength(1);
    expect(useProjectCatalogStore.getState().status).toBe('ready');
    expect(useProjectCatalogStore.getState().error).toBeNull();
  });

  it('discards a stale remote error after the scope switches', async () => {
    await useProjectCatalogStore.getState().createProject('Local One');

    let rejectList!: (err: Error) => void;
    const fake = {
      listProjects: () =>
        new Promise((_resolve, reject) => {
          rejectList = reject;
        }),
    } as unknown as ProjectRepository;
    vi.mocked(resolveProjectRepository).mockReturnValue(fake);
    useAuthStore.setState({
      authByInstance: { official: { userId: 'u1', displayName: 'Dev User' } },
    });
    useScopeStore.setState({ activeScope: { instanceId: 'official', workspaceId: 'ws_r' } });

    const staleRefresh = useProjectCatalogStore.getState().refresh();
    await useScopeStore.getState().switchScope(localScope());
    await useProjectCatalogStore.getState().refresh();
    expect(useProjectCatalogStore.getState().status).toBe('ready');

    rejectList(new Error('network died'));
    await staleRefresh;
    expect(useProjectCatalogStore.getState().status).toBe('ready');
    expect(useProjectCatalogStore.getState().error).toBeNull();
  });
});
