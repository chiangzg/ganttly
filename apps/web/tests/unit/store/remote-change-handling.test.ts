/**
 * Remote change handling for the SSE self-echo bug (spec §11.3).
 *
 * The server broadcasts `project.updated` to the whole workspace, including the
 * browser that made the write (`apps/server/src/modules/events/publisher.ts` →
 * `routes/events.ts`). That echo is indistinguishable from a foreign change by
 * `dirty` alone: the outbox poll (250 ms) means it can land while the PUT
 * response is still in flight. The old handler
 * (`if (!dirty) reloadFromRemote(); else setRemoteUpdateAvailable(true)`) then
 * raised the sticky "远端有更新" banner for the user's own edit — and, when
 * clean, ran a redundant full reload that wiped the undo history.
 *
 * {@link useProjectStore.getState().handleRemoteChange} is the single
 * revision-aware decision point that replaced that branch. These tests pin:
 *  - the echo of our own save is ignored, in both orderings (after / during);
 *  - a genuinely newer revision still reloads when clean and still flags when
 *    dirty;
 *  - `reloadFromRemote` never discards an edit that landed while its snapshot
 *    was in flight, and never moves the revision backwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createEmptyFile, DEFAULT_VIEW_STATE, type GanttlyFile } from '@ganttly/schema';
import { useProjectStore, type Command } from '@/store/useProjectStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useInstanceStore, type InstanceConfig } from '@/store/useInstanceStore';
import { setRepository } from '@/data/createRepository';
import { IndexedDBRepository } from '@/data/indexeddb';
import { localRef } from '@/data/projectRef';

const REMOTE = { instanceId: 'inst_x', workspaceId: 'ws_1', projectId: 'prj_1' };
const OTHER = { instanceId: 'inst_x', workspaceId: 'ws_1', projectId: 'prj_2' };
const INSTANCE: InstanceConfig = {
  id: 'inst_x',
  displayName: 'Inst X',
  baseUrl: 'https://instx.test',
  kind: 'custom',
};

// --- controllable stub server ----------------------------------------------

/** A promise plus its resolver, to hold a response until the test releases it. */
interface Gate {
  promise: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let serverFile: GanttlyFile;
let serverRevision: string;
let getCalls: number;
let putCalls: number;
/** When set, GET responses are held until released (captured at request time). */
let getGate: Gate | null;
/** When set, PUT responses are held after the commit (the write is durable). */
let putGate: Gate | null;
/** Fired once the PUT has committed server-side but before its response. */
let onPutCommit: (() => void) | null;

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
        // Commit first, then (optionally) hold the response back — this is the
        // window in which our own SSE echo reaches the browser.
        serverFile = withNeutralViewState(body.file);
        serverRevision = String(Number(serverRevision) + 1);
        onPutCommit?.();
        if (putGate) await putGate.promise;
        return jsonResponse(
          { summary: summaryOf(serverRevision), file: serverFile, revision: serverRevision },
          serverRevision,
        );
      }
      getCalls += 1;
      // Snapshot at request time, like a real read.
      const revision = serverRevision;
      const file = serverFile;
      if (getGate) await getGate.promise;
      return jsonResponse({ summary: summaryOf(revision), file, revision }, revision);
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
  serverFile = createEmptyFile({ name: 'Remote project' });
  serverRevision = '1';
  getCalls = 0;
  putCalls = 0;
  getGate = null;
  putGate = null;
  onPutCommit = null;
  stubRemoteServer();
  setRepository(new IndexedDBRepository());
});

afterEach(() => {
  vi.useRealTimers();
  // Drop the debounce timer and any in-flight generation between cases.
  useProjectStore.getState().unloadProject();
  vi.unstubAllGlobals();
});

describe('handleRemoteChange: the echo of our own save', () => {
  it('ignores an echo the local revision already covers (no reload, history kept)', async () => {
    await loadRemoteProject();
    useProjectStore.getState().dispatch(renameCommand('Local edit'));
    await useProjectStore.getState().save();
    expect(putCalls).toBe(1);
    expect(useProjectStore.getState().revision).toBe('2');
    const getsBefore = getCalls;

    const outcome = await useProjectStore.getState().handleRemoteChange(REMOTE, '2');

    expect(outcome).toBe('ignored');
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(false);
    expect(getCalls).toBe(getsBefore); // no redundant full reload
    expect(useProjectStore.getState().canUndo()).toBe(true); // undo survives the save
  });

  it('ignores an echo that arrives while the PUT is still in flight', async () => {
    await loadRemoteProject();
    useProjectStore.getState().dispatch(renameCommand('Local edit'));
    const holdResponse = gate();
    const committed = gate();
    putGate = holdResponse;
    onPutCommit = () => committed.release();

    const saving = useProjectStore.getState().save();
    await committed.promise; // server committed rev 2; the PUT response is held
    expect(serverRevision).toBe('2');
    expect(useProjectStore.getState().revision).toBe('1'); // response not processed yet
    expect(useProjectStore.getState().dirty).toBe(true);

    const decision = useProjectStore.getState().handleRemoteChange(REMOTE, '2');
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    // The decision must wait for the in-flight save instead of judging the echo
    // against the not-yet-advanced local revision.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(false);

    holdResponse.release();
    const [outcome] = await Promise.all([decision, saving]);

    expect(outcome).toBe('ignored');
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(false);
    expect(useProjectStore.getState().revision).toBe('2');
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(getCalls).toBe(1); // only the initial load — no echo-triggered reload
    expect(useProjectStore.getState().canUndo()).toBe(true);
  });

  it('ignores a stale revision (an event we already raced past)', async () => {
    await loadRemoteProject();
    useProjectStore.getState().dispatch(renameCommand('Local edit'));
    await useProjectStore.getState().save(); // local rev 2

    expect(await useProjectStore.getState().handleRemoteChange(REMOTE, '1')).toBe('ignored');
    expect(getCalls).toBe(1);
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(false);
  });
});

describe('handleRemoteChange: foreign changes', () => {
  it('reloads when a newer revision arrives while clean', async () => {
    await loadRemoteProject();
    serverFile = withNeutralViewState(createEmptyFile({ name: 'Server edit' }));
    serverRevision = '2';
    const getsBefore = getCalls;

    const outcome = await useProjectStore.getState().handleRemoteChange(REMOTE, '2');

    expect(outcome).toBe('reloaded');
    expect(useProjectStore.getState().file.project.name).toBe('Server edit');
    expect(useProjectStore.getState().revision).toBe('2');
    expect(getCalls).toBe(getsBefore + 1);
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(false);
  });

  it('flags (never overwrites) when a newer revision arrives while dirty', async () => {
    await loadRemoteProject();
    useProjectStore.getState().dispatch(renameCommand('Local edit'));
    const fileBefore = useProjectStore.getState().file;
    const getsBefore = getCalls;

    const outcome = await useProjectStore.getState().handleRemoteChange(REMOTE, '2');

    expect(outcome).toBe('flagged');
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(true);
    expect(useProjectStore.getState().file).toBe(fileBefore);
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(getCalls).toBe(getsBefore); // nothing fetched
  });

  it('treats a revision-less event (archive/restore) as a remote change', async () => {
    await loadRemoteProject();
    serverFile = withNeutralViewState(createEmptyFile({ name: 'Archived elsewhere' }));
    expect(await useProjectStore.getState().handleRemoteChange(REMOTE, undefined)).toBe('reloaded');
    expect(useProjectStore.getState().file.project.name).toBe('Archived elsewhere');

    useProjectStore.getState().dispatch(renameCommand('Local edit'));
    expect(await useProjectStore.getState().handleRemoteChange(REMOTE, undefined)).toBe('flagged');
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(true);
  });

  it('ignores events for another project and for a local ref', async () => {
    await loadRemoteProject();
    const fileBefore = useProjectStore.getState().file;

    expect(await useProjectStore.getState().handleRemoteChange(OTHER, '2')).toBe('ignored');
    expect(await useProjectStore.getState().handleRemoteChange(localRef('prj_local'), '2')).toBe(
      'ignored',
    );
    expect(useProjectStore.getState().file).toBe(fileBefore);
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(false);
    expect(getCalls).toBe(1);
  });
});

describe('reloadFromRemote: concurrency guards', () => {
  it('never discards an edit made while the snapshot was in flight', async () => {
    await loadRemoteProject();
    const holdGet = gate();
    getGate = holdGet;

    const reloading = useProjectStore.getState().reloadFromRemote();
    // The user starts typing while the GET is in flight.
    useProjectStore.getState().dispatch(renameCommand('Typed during reload'));
    holdGet.release();

    await expect(reloading).resolves.toBe(false);
    const state = useProjectStore.getState();
    expect(state.file.project.name).toBe('Typed during reload'); // edit survived
    expect(state.dirty).toBe(true);
    expect(state.remoteUpdateAvailable).toBe(true); // skipped change is not silent
  });

  it('re-arms the debounced save cleared by the reload', async () => {
    await loadRemoteProject();
    const holdGet = gate();
    getGate = holdGet;
    const reloading = useProjectStore.getState().reloadFromRemote();

    vi.useFakeTimers();
    useProjectStore.getState().dispatch(renameCommand('Typed during reload'));
    holdGet.release();
    await expect(reloading).resolves.toBe(false);
    expect(putCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(600);

    expect(putCalls).toBe(1); // the edit is still on its way to the server
    expect(serverFile.project.name).toBe('Typed during reload');
  });

  it('never moves the revision backwards when a save lands mid-fetch', async () => {
    await loadRemoteProject();
    const holdGet = gate();
    getGate = holdGet;

    // The reload captures rev 1, then a save commits rev 2 before it returns.
    const reloading = useProjectStore.getState().reloadFromRemote();
    useProjectStore.getState().dispatch(renameCommand('Saved during reload'));
    await useProjectStore.getState().save();
    expect(useProjectStore.getState().revision).toBe('2');
    holdGet.release();

    await expect(reloading).resolves.toBe(false);
    const state = useProjectStore.getState();
    expect(state.revision).toBe('2'); // stale snapshot not adopted
    expect(state.file.project.name).toBe('Saved during reload');
    expect(state.dirty).toBe(false);
  });

  it('still discards local edits when the user explicitly reloads (banner button)', async () => {
    await loadRemoteProject();
    useProjectStore.getState().dispatch(renameCommand('Local edit'));
    expect(useProjectStore.getState().dirty).toBe(true);
    serverFile = withNeutralViewState(createEmptyFile({ name: 'Server edit' }));
    serverRevision = '2';

    await expect(useProjectStore.getState().reloadFromRemote()).resolves.toBe(true);

    const state = useProjectStore.getState();
    expect(state.file.project.name).toBe('Server edit');
    expect(state.dirty).toBe(false);
    expect(state.remoteUpdateAvailable).toBe(false);
  });
});
