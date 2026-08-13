import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumePostLoginRedirect, peekLoginError, useAuthStore } from '@/store/useAuthStore';
import type { InstanceConfig } from '@/store/useInstanceStore';

const official: InstanceConfig = {
  id: 'official',
  displayName: 'ganttly Cloud',
  baseUrl: 'https://app.ganttly.test',
  kind: 'official',
};

function mockFetch(body: unknown, status = 200): void {
  // 204 No Content must not carry a body.
  if (status === 204) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    return;
  }
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

describe('useAuthStore', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.setState({ authByInstance: {}, checked: new Set() });
    fetchSpy.mockReset();
  });
  afterEach(() => fetchSpy.mockReset());

  describe('checkAuth', () => {
    it('stores profile on 200', async () => {
      mockFetch({ id: 'usr_1', displayName: 'Alice' });
      const profile = await useAuthStore.getState().checkAuth(official);
      expect(profile).toEqual({ userId: 'usr_1', displayName: 'Alice' });
      expect(useAuthStore.getState().isAuthenticated('official')).toBe(true);
    });

    it('sets null on 401', async () => {
      mockFetch({ error: { code: 'AUTH_REQUIRED' } }, 401);
      const profile = await useAuthStore.getState().checkAuth(official);
      expect(profile).toBeNull();
      expect(useAuthStore.getState().isAuthenticated('official')).toBe(false);
    });

    it('sets null on network error', async () => {
      fetchSpy.mockRejectedValue(new Error('network'));
      const profile = await useAuthStore.getState().checkAuth(official);
      expect(profile).toBeNull();
    });

    it('marks instance as checked', async () => {
      mockFetch({ id: 'usr_1', displayName: null });
      await useAuthStore.getState().checkAuth(official);
      expect(useAuthStore.getState().checked.has('official')).toBe(true);
    });
  });

  describe('login', () => {
    it('stashes return path in sessionStorage', () => {
      // The sessionStorage write happens before the redirect, so we verify
      // that side-effect. jsdom logs a harmless "Not implemented" warning for
      // the cross-origin navigation assignment.
      useAuthStore.getState().login(official, '/instances/official/workspaces/ws1/projects');
      const stashed = consumePostLoginRedirect();
      expect(stashed).toEqual({
        instanceId: 'official',
        path: '/instances/official/workspaces/ws1/projects',
      });
    });
  });

  describe('logout', () => {
    it('POSTs logout and clears auth', async () => {
      mockFetch(null, 204);
      useAuthStore.setState({
        authByInstance: { official: { userId: 'usr_1', displayName: 'A' } },
      });
      await useAuthStore.getState().logout(official);
      expect(useAuthStore.getState().isAuthenticated('official')).toBe(false);
    });
  });

  describe('clearAuth', () => {
    it('removes the entry and checked flag', () => {
      useAuthStore.setState({
        authByInstance: { official: { userId: 'u', displayName: null } },
        checked: new Set(['official']),
      });
      useAuthStore.getState().clearAuth('official');
      expect(useAuthStore.getState().authByInstance['official']).toBeUndefined();
      expect(useAuthStore.getState().checked.has('official')).toBe(false);
    });
  });

  describe('post-login redirect helpers', () => {
    it('consumePostLoginRedirect returns null when empty', () => {
      sessionStorage.clear();
      expect(consumePostLoginRedirect()).toBeNull();
    });

    it('consumePostLoginRedirect removes after reading', () => {
      sessionStorage.setItem(
        'ganttly:post-login-redirect',
        JSON.stringify({ instanceId: 'official', path: '/x' }),
      );
      expect(consumePostLoginRedirect()).toEqual({ instanceId: 'official', path: '/x' });
      expect(consumePostLoginRedirect()).toBeNull();
    });

    it('peekLoginError reads and cleans the query param', () => {
      const original = window.location.href;
      window.history.replaceState(null, '', '/?login_error=github_login_failed');
      expect(peekLoginError()).toBe('github_login_failed');
      expect(window.location.search).toBe('');
      window.history.replaceState(null, '', original);
    });

    it('peekLoginError returns null when absent', () => {
      const original = window.location.href;
      window.history.replaceState(null, '', '/');
      expect(peekLoginError()).toBeNull();
      window.history.replaceState(null, '', original);
    });
  });
});
