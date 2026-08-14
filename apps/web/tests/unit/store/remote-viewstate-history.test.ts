/**
 * Remote-project viewState history semantics (spec §5.2):
 * - viewState-only commands on a remote project persist to the per-device
 *   cache without dirtying the document or bumping the server revision;
 * - undo/redo of those commands follow the same rule (no server save);
 * - reloadFromRemote is remote-only and never discards local edits;
 * - loadProject clears a stale remoteUpdateAvailable flag.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { useProjectStore, setViewStateCommand } from '@/store/useProjectStore';
import { useAuthStore } from '@/store/useAuthStore';
import { localRef } from '@/data/projectRef';
import { setRepository } from '@/data/createRepository';
import { IndexedDBRepository } from '@/data/indexeddb';
import { DEFAULT_PROJECT_ID } from '@/data/repository';

const REMOTE = { instanceId: 'inst_x', workspaceId: 'ws_1', projectId: 'prj_1' };

async function reset() {
  const repo = new IndexedDBRepository();
  for (const m of await repo.listProjects()) await repo.deleteProject(m.id);
  setRepository(repo);
  await useProjectStore.getState().init(repo);
  useProjectStore.setState({
    activeProjectRef: null,
    dirty: false,
    saveState: { status: 'idle' },
    undoStack: [],
    redoStack: [],
    remoteUpdateAvailable: false,
  });
}

describe('remote viewState undo/redo (H-7)', () => {
  beforeEach(async () => {
    await reset();
    useAuthStore.setState({
      authByInstance: { inst_x: { userId: 'u1', displayName: 'U' } },
    });
    useProjectStore.setState({
      activeProjectRef: REMOTE,
      dirty: false,
      saveState: { status: 'idle' },
      undoStack: [],
      redoStack: [],
    });
  });

  it('dispatch of a viewState command on a remote project does not dirty', () => {
    const store = useProjectStore.getState;
    store().dispatch(setViewStateCommand({ zoom: 'day' }));
    expect(store().file.viewState.zoom).toBe('day');
    expect(store().dirty).toBe(false);
    expect(store().saveState.status).toBe('idle');
    expect(store().canUndo()).toBe(true);
  });

  it('undo of a viewState command stays non-dirty and restores the state', () => {
    const store = useProjectStore.getState;
    store().dispatch(setViewStateCommand({ zoom: 'day' }));
    store().undo();
    expect(store().file.viewState.zoom).toBe('week');
    expect(store().dirty).toBe(false);
    expect(store().saveState.status).toBe('idle');
    expect(store().canRedo()).toBe(true);
  });

  it('redo of a viewState command stays non-dirty', () => {
    const store = useProjectStore.getState;
    store().dispatch(setViewStateCommand({ zoom: 'day' }));
    store().undo();
    store().redo();
    expect(store().file.viewState.zoom).toBe('day');
    expect(store().dirty).toBe(false);
    expect(store().saveState.status).toBe('idle');
  });

  it('undo walks back through consecutive viewState commands without dirtying', () => {
    const store = useProjectStore.getState;
    store().dispatch(setViewStateCommand({ zoom: 'day' }));
    store().dispatch(setViewStateCommand({ zoom: 'month' }));
    store().undo();
    expect(store().file.viewState.zoom).toBe('day');
    expect(store().dirty).toBe(false);
    store().undo();
    expect(store().file.viewState.zoom).toBe('week');
    expect(store().dirty).toBe(false);
    expect(store().saveState.status).toBe('idle');
  });
});

describe('remote-only guards (H-8)', () => {
  beforeEach(async () => {
    await reset();
  });

  it('reloadFromRemote refuses to run for a local ref', async () => {
    const store = useProjectStore.getState;
    store().dispatch(setViewStateCommand({ zoom: 'day' }));
    useProjectStore.setState({
      activeProjectRef: localRef(DEFAULT_PROJECT_ID),
      dirty: true,
    });
    const before = useProjectStore.getState().file;
    const result = await store().reloadFromRemote();
    expect(result).toBe(false);
    expect(useProjectStore.getState().file).toBe(before);
    expect(useProjectStore.getState().dirty).toBe(true); // untouched
  });

  it('loadProject clears a stale remoteUpdateAvailable flag', async () => {
    const store = useProjectStore.getState;
    // A second project so loadProject takes the full (non-early-return) path.
    const second = await useProjectStore.getState().repo!.createProject({
      file: useProjectStore.getState().file,
    });
    useProjectStore.setState({ remoteUpdateAvailable: true });
    await store().loadProject(localRef(second.summary.id));
    expect(useProjectStore.getState().activeProjectRef).toEqual(localRef(second.summary.id));
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(false);
  });
});
