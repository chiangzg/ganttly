/**
 * Regression tests for "save snaps the view back to the top" (remote projects).
 *
 * The server substitutes a neutral DEFAULT viewState on PUT/GET (spec §5.2)
 * and the per-device localStorage cache lags the live scroll position
 * (scrolling never writes the cache), so any code path that rebinds `file` to
 * a server snapshot must explicitly carry over the live viewState — otherwise
 * the synced scroll containers (TaskTable + GanttCanvas) jump to scrollTop 0.
 *
 * Covered paths:
 *  - performSave adopts the snapshot's data but keeps the live viewState;
 *  - a clean Cmd+S is a no-op (no PUT, no rebind at all);
 *  - reloadFromRemote (SSE push / banner reload) keeps the live viewState.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createEmptyFile, DEFAULT_VIEW_STATE, type GanttlyFile } from '@ganttly/schema';
import { useProjectStore, type Command } from '@/store/useProjectStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useInstanceStore, type InstanceConfig } from '@/store/useInstanceStore';
import { setRepository } from '@/data/createRepository';
import { IndexedDBRepository } from '@/data/indexeddb';

const REMOTE = { instanceId: 'inst_x', workspaceId: 'ws_1', projectId: 'prj_1' };
const INSTANCE: InstanceConfig = {
  id: 'inst_x',
  displayName: 'Inst X',
  baseUrl: 'https://instx.test',
  kind: 'custom',
};

function summaryOf(revision: string) {
  return {
    id: REMOTE.projectId,
    name: 'Remote project',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: `2026-09-07T0${revision}:00:00Z`,
    deletedAt: null,
    taskCount: 0,
    completedTaskCount: 0,
    progress: 0,
  };
}

/** The real server ignores client viewState and stores the neutral default. */
function withNeutralViewState(file: GanttlyFile): GanttlyFile {
  return { ...file, viewState: { ...DEFAULT_VIEW_STATE, collapsedTaskIds: [] } };
}

function jsonResponse(payload: unknown, revision: string): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', etag: `"${revision}"` },
  });
}

let getCannedFile: () => GanttlyFile;
let putCalls: number;

function stubRemoteServer(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = String(url);
      if (!path.includes(`/workspaces/${REMOTE.workspaceId}/projects/${REMOTE.projectId}`)) {
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: path } }), {
          status: 404,
        });
      }
      if (method === 'PUT') {
        putCalls += 1;
        const body = JSON.parse(String(init.body)) as { file: GanttlyFile };
        // Acknowledge the client's data but bounce the viewState to neutral,
        // exactly like apps/server does on PUT.
        return jsonResponse(
          {
            summary: summaryOf('2'),
            file: withNeutralViewState({
              ...body.file,
              project: { ...body.file.project, name: 'Server-ack' },
            }),
            revision: '2',
          },
          '2',
        );
      }
      return jsonResponse({ summary: summaryOf('1'), file: getCannedFile(), revision: '1' }, '1');
    }),
  );
}

async function loadRemoteProject(): Promise<void> {
  useAuthStore.setState({
    authByInstance: { inst_x: { userId: 'u1', displayName: 'U' } },
  });
  useInstanceStore.setState({ customInstances: [INSTANCE] });
  useProjectStore.setState({
    activeProjectRef: null,
    dirty: false,
    loadState: 'idle',
    saveState: { status: 'idle' },
    undoStack: [],
    redoStack: [],
    remoteUpdateAvailable: false,
  });
  expect(await useProjectStore.getState().loadProject(REMOTE)).toBe(true);
}

/** Mirror TaskTable.onScroll: direct setState, never dirtying the document. */
function scrollTo(top: number): void {
  const { file } = useProjectStore.getState();
  useProjectStore.setState({
    file: { ...file, viewState: { ...file.viewState, scrollTop: top } },
  });
}

function renameCommand(name: string): Command {
  const before = useProjectStore.getState().file.project.name;
  return {
    label: 'rename',
    apply: (file) => ({ ...file, project: { ...file.project, name } }),
    invert: (file) => ({ ...file, project: { ...file.project, name: before } }),
  };
}

beforeEach(() => {
  localStorage.clear();
  stubRemoteServer();
  getCannedFile = () => createEmptyFile({ name: 'Remote project' });
  putCalls = 0;
  setRepository(new IndexedDBRepository());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('save keeps the live viewState (remote)', () => {
  it('performSave adopts the snapshot data but preserves scrollTop', async () => {
    await loadRemoteProject();
    scrollTo(500);
    useProjectStore.getState().dispatch(renameCommand('Local edit'));
    expect(useProjectStore.getState().dirty).toBe(true);

    await useProjectStore.getState().save();

    expect(putCalls).toBe(1);
    const { file, dirty, saveState, revision } = useProjectStore.getState();
    expect(file.project.name).toBe('Server-ack'); // snapshot data adopted
    expect(file.viewState.scrollTop).toBe(500); // live scroll preserved
    expect(dirty).toBe(false);
    expect(saveState.status).toBe('saved');
    expect(revision).toBe('2');
  });

  it('a clean Cmd+S is a no-op: no PUT, no file rebind', async () => {
    await loadRemoteProject();
    scrollTo(300);
    const fileBefore = useProjectStore.getState().file;

    await useProjectStore.getState().save();

    expect(putCalls).toBe(0);
    expect(useProjectStore.getState().file).toBe(fileBefore);
    expect(useProjectStore.getState().file.viewState.scrollTop).toBe(300);
    expect(useProjectStore.getState().saveState.status).toBe('saved');
  });
});

describe('reloadFromRemote keeps the live viewState (remote)', () => {
  it('adopts remote edits without resetting scrollTop', async () => {
    await loadRemoteProject();
    scrollTo(500);
    getCannedFile = () => withNeutralViewState({ ...createEmptyFile({ name: 'Server edit' }) });

    expect(await useProjectStore.getState().reloadFromRemote()).toBe(true);

    const { file, revision } = useProjectStore.getState();
    expect(file.project.name).toBe('Server edit'); // remote data adopted
    expect(file.viewState.scrollTop).toBe(500); // live scroll preserved
    expect(revision).toBe('1');
  });
});
