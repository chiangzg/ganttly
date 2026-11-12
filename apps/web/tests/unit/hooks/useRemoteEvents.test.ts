/**
 * SSE wiring for {@link useRemoteEvents} (spec §11.3).
 *
 * The hook is a thin adapter: it decides *which* stream events belong to the
 * open project and delegates the actual policy (ignore the echo of our own
 * save / reload / flag) to `useProjectStore.handleRemoteChange`. These tests
 * pin the two ends of that contract:
 *  - local scope opens no stream at all (nothing in this change can reach local
 *    mode);
 *  - a `project.updated` echo the local revision already covers must NOT raise
 *    the "远端有更新" banner, while a genuinely newer revision still does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ProjectEvent } from '@ganttly/api-contract';
import { createEmptyFile } from '@ganttly/schema';
import { useRemoteEvents } from '@/hooks/useRemoteEvents';
import { createEventStream, type RemoteEventStreamOptions } from '@/data/sseClient';
import { useProjectStore } from '@/store/useProjectStore';
import { useProjectCatalogStore } from '@/store/useProjectCatalogStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useInstanceStore, type InstanceConfig } from '@/store/useInstanceStore';
import { useScopeStore } from '@/store/useScopeStore';
import { localScope } from '@/data/projectRef';

vi.mock('@/data/sseClient', () => ({ createEventStream: vi.fn() }));

const REMOTE_SCOPE = { instanceId: 'inst_x', workspaceId: 'ws_1' };
const REMOTE = { ...REMOTE_SCOPE, projectId: 'prj_1' };
const INSTANCE: InstanceConfig = {
  id: 'inst_x',
  displayName: 'Inst X',
  baseUrl: 'https://instx.test',
  kind: 'custom',
};

const createEventStreamMock = vi.mocked(createEventStream);

/** Options object captured from the (mocked) stream the hook opened. */
let stream: RemoteEventStreamOptions | null;

function projectEvent(projectId: string, revision?: string): ProjectEvent {
  return {
    id: 1,
    type: 'project.updated',
    workspaceId: 'ws_1',
    projectId,
    revision,
    actor: { type: 'web', id: 'u2' },
    createdAt: '2026-09-07T00:00:00.000Z',
  };
}

/** Mount the hook over a remote, authenticated, ready project at `revision`. */
function mountRemote(revision: string) {
  useScopeStore.setState({ activeScope: REMOTE_SCOPE });
  useInstanceStore.setState({ customInstances: [INSTANCE] });
  useAuthStore.setState({ authByInstance: { inst_x: { userId: 'u1', displayName: 'U' } } });
  useProjectStore.setState({
    activeProjectRef: REMOTE,
    revision,
    file: createEmptyFile({ name: 'Remote project' }),
    dirty: false,
    loadState: 'ready',
    saveState: { status: 'saved' },
    remoteUpdateAvailable: false,
    undoStack: [],
    redoStack: [],
  });
  return renderHook(() => useRemoteEvents());
}

beforeEach(() => {
  vi.useFakeTimers();
  stream = null;
  createEventStreamMock.mockReset();
  createEventStreamMock.mockImplementation((options: RemoteEventStreamOptions) => {
    stream = options;
    return { state: 'open', close: vi.fn() };
  });
});

afterEach(() => {
  vi.useRealTimers();
  useProjectStore.getState().unloadProject();
  useScopeStore.setState({ activeScope: localScope() });
  useAuthStore.setState({ authByInstance: {} });
  useInstanceStore.setState({ customInstances: [] });
});

describe('useRemoteEvents', () => {
  it('opens no stream for the local scope', () => {
    useScopeStore.setState({ activeScope: localScope() });

    const { unmount } = renderHook(() => useRemoteEvents());

    expect(createEventStreamMock).not.toHaveBeenCalled();
    unmount();
  });

  it('does not raise the banner for the echo of our own save', async () => {
    const refreshSpy = vi
      .spyOn(useProjectCatalogStore.getState(), 'refresh')
      .mockResolvedValue(undefined);
    const { unmount } = mountRemote('2');
    expect(stream).not.toBeNull();

    stream!.onEvent(projectEvent('prj_1', '2'));

    // The echo is 'ignored' — no banner and no catalog refresh (debounce timer
    // included), so an ordinary edit never churns the project list.
    await vi.advanceTimersByTimeAsync(1000);
    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(false);
    expect(refreshSpy).not.toHaveBeenCalled();
    refreshSpy.mockRestore();
    unmount();
  });

  it('still raises the banner for a newer revision while dirty', async () => {
    const refreshSpy = vi
      .spyOn(useProjectCatalogStore.getState(), 'refresh')
      .mockResolvedValue(undefined);
    const { unmount } = mountRemote('2');
    useProjectStore.setState({ dirty: true });

    stream!.onEvent(projectEvent('prj_1', '3'));

    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(true);
    // A foreign change ('flagged') refreshes the catalog after the debounce so
    // tab labels pick up e.g. a rename made from another client.
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    refreshSpy.mockRestore();
    unmount();
  });

  it('refreshes the catalog when a foreign change reloads the current project', async () => {
    const refreshSpy = vi
      .spyOn(useProjectCatalogStore.getState(), 'refresh')
      .mockResolvedValue(undefined);
    const original = useProjectStore.getState().handleRemoteChange;
    // Stub the outcome to 'reloaded' — the clean-state branch would otherwise
    // hit the network through the remote repository.
    useProjectStore.setState({ handleRemoteChange: vi.fn().mockResolvedValue('reloaded') });
    const { unmount } = mountRemote('2');

    stream!.onEvent(projectEvent('prj_1', '3'));

    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    useProjectStore.setState({ handleRemoteChange: original });
    refreshSpy.mockRestore();
    unmount();
  });
});
