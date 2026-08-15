import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScopeStore, type WorkspaceSummary } from '@/store/useScopeStore';
import type { InstanceConfig } from '@/store/useInstanceStore';
import { localScope } from '@/data/projectRef';

const official: InstanceConfig = {
  id: 'official',
  displayName: 'ganttly Cloud',
  baseUrl: 'https://app.test',
  kind: 'official',
};

describe('useScopeStore', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    useScopeStore.setState({
      activeScope: localScope(),
      workspacesByInstance: {},
      loadingInstances: new Set(),
    });
    fetchSpy.mockReset();
  });
  afterEach(() => fetchSpy.mockReset());

  describe('default scope', () => {
    it('starts on the local scope', () => {
      expect(useScopeStore.getState().activeScope).toEqual({
        instanceId: 'local',
        workspaceId: 'local',
      });
    });
  });

  describe('switchScope', () => {
    it('switches when flush succeeds', async () => {
      const flush = vi.fn().mockResolvedValue(undefined);
      const ok = await useScopeStore
        .getState()
        .switchScope({ instanceId: 'official', workspaceId: 'ws_1' }, flush);
      expect(ok).toBe(true);
      expect(flush).toHaveBeenCalled();
      expect(useScopeStore.getState().activeScope).toEqual({
        instanceId: 'official',
        workspaceId: 'ws_1',
      });
    });

    it('aborts when flush throws', async () => {
      const flush = vi.fn().mockRejectedValue(new Error('save failed'));
      const ok = await useScopeStore
        .getState()
        .switchScope({ instanceId: 'official', workspaceId: 'ws_1' }, flush);
      expect(ok).toBe(false);
      expect(useScopeStore.getState().activeScope).toEqual(localScope());
    });

    it('is a no-op when switching to the same scope', async () => {
      const flush = vi.fn();
      const ok = await useScopeStore.getState().switchScope(localScope(), flush);
      expect(ok).toBe(true);
      expect(flush).not.toHaveBeenCalled();
    });
  });

  describe('loadWorkspaces', () => {
    it('fetches and stores the workspace list', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            workspaces: [{ id: 'ws_1', name: 'Personal', kind: 'personal', role: 'owner' }],
          }),
          { status: 200 },
        ),
      );
      const workspaces = await useScopeStore.getState().loadWorkspaces(official);
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.instanceId).toBe('official');
      const cached = useScopeStore.getState().getWorkspaces('official');
      expect(cached).toEqual(workspaces);
    });

    it('returns empty on non-ok', async () => {
      fetchSpy.mockResolvedValue(new Response('unauth', { status: 401 }));
      const workspaces: WorkspaceSummary[] = await useScopeStore
        .getState()
        .loadWorkspaces(official);
      expect(workspaces).toEqual([]);
    });
  });

  describe('resetToLocal', () => {
    it('resets the active scope to local', async () => {
      await useScopeStore
        .getState()
        .switchScope({ instanceId: 'official', workspaceId: 'ws_1' }, async () => {});
      useScopeStore.getState().resetToLocal();
      expect(useScopeStore.getState().activeScope).toEqual(localScope());
    });
  });
});
