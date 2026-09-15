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
  stream = null;
  createEventStreamMock.mockReset();
  createEventStreamMock.mockImplementation((options: RemoteEventStreamOptions) => {
    stream = options;
    return { state: 'open', close: vi.fn() };
  });
});

afterEach(() => {
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

  it('does not raise the banner for the echo of our own save', () => {
    const { unmount } = mountRemote('2');
    expect(stream).not.toBeNull();

    stream!.onEvent(projectEvent('prj_1', '2'));

    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(false);
    unmount();
  });

  it('still raises the banner for a newer revision while dirty', () => {
    const { unmount } = mountRemote('2');
    useProjectStore.setState({ dirty: true });

    stream!.onEvent(projectEvent('prj_1', '3'));

    expect(useProjectStore.getState().remoteUpdateAvailable).toBe(true);
    unmount();
  });
});
