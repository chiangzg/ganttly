import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyFile } from '@ganttly/schema';
import { useProjectStore, setViewStateCommand } from '@/store/useProjectStore';
import { useAuthStore } from '@/store/useAuthStore';
import { loadViewState } from '@/data/viewStateStore';
import { localRef, type ProjectRef } from '@/data/projectRef';

const REMOTE_REF: ProjectRef = {
  instanceId: 'official',
  workspaceId: 'ws_test',
  projectId: 'prj_remote',
};
const USER_ID = 'usr_test';

describe('viewState separation (spec §5.2)', () => {
  beforeEach(() => {
    localStorage.clear();
    // Seed the project store with an active remote project.
    useProjectStore.setState({
      file: createEmptyFile({ name: 'Remote' }),
      activeProjectRef: REMOTE_REF,
      revision: '1',
      dirty: false,
      loadState: 'ready',
      undoStack: [],
      redoStack: [],
    });
    // Seed the auth store so the viewStateStore can resolve the userId.
    useAuthStore.setState({
      authByInstance: { official: { userId: USER_ID, displayName: 'Tester' } },
      checked: new Set(['official']),
    });
  });

  afterEach(() => {
    useProjectStore.setState({
      activeProjectRef: null,
      revision: null,
      dirty: false,
      loadState: 'idle',
      undoStack: [],
      redoStack: [],
    });
    useAuthStore.setState({ authByInstance: {}, checked: new Set() });
  });

  it('does NOT mark dirty after a viewState-only command on a remote project', () => {
    useProjectStore.getState().dispatch(setViewStateCommand({ scrollTop: 999 }));
    expect(useProjectStore.getState().dirty).toBe(false);
  });

  it('persists the viewState to the local per-device cache', () => {
    useProjectStore.getState().dispatch(setViewStateCommand({ scrollTop: 777, zoom: 'day' }));
    const vs = loadViewState(USER_ID, REMOTE_REF);
    expect(vs.scrollTop).toBe(777);
    expect(vs.zoom).toBe('day');
  });

  it('updates the in-memory file so the UI reflects the change', () => {
    useProjectStore.getState().dispatch(setViewStateCommand({ scrollLeft: 123 }));
    expect(useProjectStore.getState().file.viewState.scrollLeft).toBe(123);
  });

  it('DOES mark dirty for a viewState command on a LOCAL project', () => {
    useProjectStore.setState({ activeProjectRef: localRef('prj_local') });
    useProjectStore.getState().dispatch(setViewStateCommand({ scrollTop: 42 }));
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('pushes to the undo stack even for remote viewState commands', () => {
    useProjectStore.getState().dispatch(setViewStateCommand({ scrollTop: 100 }));
    expect(useProjectStore.getState().undoStack).toHaveLength(1);
  });
});
