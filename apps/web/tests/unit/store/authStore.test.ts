import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumePostLoginRedirect,
  loginErrorMessage,
  peekLoginError,
  useAuthStore,
} from '@/store/useAuthStore';
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
    useAuthStore.setState({ authByInstance: {}, checked: new Set(), lastLoginError: null });
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
    it('stashes return path and redirects when the server is reachable', async () => {
      // `/me` answers 401 before login — the expected pre-flight answer.
      mockFetch({ error: { code: 'AUTH_REQUIRED' } }, 401);
      // jsdom logs a harmless "Not implemented" warning for the cross-origin
      // navigation assignment.
      const started = await useAuthStore
        .getState()
        .login(official, '/instances/official/workspaces/ws1/projects');
      expect(started).toBe(true);
      const stashed = consumePostLoginRedirect();
      expect(stashed).toEqual({
        instanceId: 'official',
        path: '/instances/official/workspaces/ws1/projects',
      });
    });

    it('returns false without stashing when the instance is unreachable', async () => {
      // A downed backend surfaces as a proxy 500 page — fail fast instead of
      // navigating the user onto it.
      mockFetch({ error: { code: 'PROXY_ERROR' } }, 500);
      const started = await useAuthStore.getState().login(official);
      expect(started).toBe(false);
      expect(sessionStorage.getItem('ganttly:post-login-redirect')).toBeNull();
    });

    it('returns false without stashing on network error', async () => {
      fetchSpy.mockRejectedValue(new Error('network'));
      const started = await useAuthStore.getState().login(official);
      expect(started).toBe(false);
      expect(sessionStorage.getItem('ganttly:post-login-redirect')).toBeNull();
    });
  });

  describe('devLogin', () => {
    it('provisions the dev session and re-checks /me on success', async () => {
      const calls: Array<{ body?: string; contentType?: string }> = [];
      let call = 0;
      // Re-spy (like mockFetch) rather than configuring the shared fetchSpy:
      // earlier mockFetch calls wrap the spy, and a stale mockResolvedValue on
      // the outer wrapper would otherwise answer these fetches.
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input: unknown, init?: RequestInit) => {
          call += 1;
          if (call === 1) {
            const headers = new Headers(init?.headers);
            calls.push({
              body: init?.body as string | undefined,
              contentType: headers.get('Content-Type') ?? undefined,
            });
          }
          // 1st call: POST /auth/dev-session; 2nd: GET /me with the session.
          return call === 1
            ? new Response(JSON.stringify({ ok: true, userId: 'usr_dev' }), { status: 200 })
            : new Response(JSON.stringify({ id: 'usr_dev', displayName: 'Dev User' }), {
                status: 200,
              });
        },
      );
      const profile = await useAuthStore.getState().devLogin(official);
      expect(profile).toEqual({ userId: 'usr_dev', displayName: 'Dev User' });
      expect(useAuthStore.getState().isAuthenticated('official')).toBe(true);
      // Fastify rejects an empty body with a JSON Content-Type — the POST
      // must carry a serialized object.
      expect(calls[0]).toEqual({ body: '{}', contentType: 'application/json' });
    });

    it('returns null when the instance rejects dev sessions (not dev mode)', async () => {
      mockFetch({ error: { code: 'NOT_FOUND' } }, 404);
      const profile = await useAuthStore.getState().devLogin(official);
      expect(profile).toBeNull();
      expect(useAuthStore.getState().isAuthenticated('official')).toBe(false);
    });

    it('returns null on network error', async () => {
      fetchSpy.mockRejectedValue(new Error('network'));
      const profile = await useAuthStore.getState().devLogin(official);
      expect(profile).toBeNull();
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

  describe('login error capture', () => {
    const originalHref = window.location.href;
    afterEach(() => window.history.replaceState(null, '', originalHref));

    it('captureLoginError stashes the code and cleans the URL', () => {
      window.history.replaceState(null, '', '/?login_error=not_allowed');
      useAuthStore.getState().captureLoginError();
      expect(useAuthStore.getState().lastLoginError).toBe('not_allowed');
      expect(window.location.search).toBe('');
    });

    it('captureLoginError leaves state untouched when no param is present', () => {
      window.history.replaceState(null, '', '/');
      useAuthStore.getState().captureLoginError();
      expect(useAuthStore.getState().lastLoginError).toBeNull();
    });

    it('consumeLoginError returns and clears (consume-on-read)', () => {
      useAuthStore.setState({ lastLoginError: 'github_login_failed' });
      expect(useAuthStore.getState().consumeLoginError()).toBe('github_login_failed');
      expect(useAuthStore.getState().lastLoginError).toBeNull();
      expect(useAuthStore.getState().consumeLoginError()).toBeNull();
    });

    it('loginErrorMessage maps known codes and falls back for unknown ones', () => {
      expect(loginErrorMessage('not_allowed')).toMatch(/白名单/);
      expect(loginErrorMessage('dev_mode_no_github')).toMatch(/开发模式/);
      expect(loginErrorMessage('github_login_failed')).toMatch(/重试/);
      expect(loginErrorMessage('mystery')).toMatch(/mystery/);
      expect(loginErrorMessage(null)).toBeNull();
    });
  });
});
