/**
 * Per-instance authentication state (spec §2.3/§12.1).
 *
 * The server uses an HttpOnly session cookie — JavaScript never sees the
 * token. This store caches the result of `GET /me` so components can render
 * login-gated UI without a network round-trip on every paint.
 *
 * **No persistence:** the cookie is the source of truth. On app load the auth
 * state is empty; scopes call {@link checkAuth} lazily when the user navigates
 * to them. A page refresh re-checks only the instances the user actually opens.
 *
 * **Login flow:** {@link login} stashes the current path in `sessionStorage`
 * and redirects to the server's GitHub OAuth entrypoint. The server redirects
 * back to the web app root after success/failure; a post-login hook reads the
 * stashed path and navigates the user back to where they were.
 */
import { create } from 'zustand';
import type { InstanceConfig } from './useInstanceStore';

const RETURN_TO_KEY = 'ganttly:post-login-redirect';

export interface UserProfile {
  userId: string;
  displayName: string | null;
}

interface MeResponse {
  id: string;
  displayName: string | null;
}

interface AuthState {
  authByInstance: Record<string, UserProfile | null>;
  /** True once at least one checkAuth has resolved (not necessarily logged in). */
  checked: Set<string>;
  /**
   * Failure code delivered back from the server via `?login_error=` (e.g.
   * OAuth denial). Captured once at app start before navigation rewrites the
   * URL; consumed by PostLoginRedirect / LoginGate to render the reason.
   */
  lastLoginError: string | null;

  isAuthenticated(instanceId: string): boolean;
  getProfile(instanceId: string): UserProfile | null;
  checkAuth(instance: InstanceConfig): Promise<UserProfile | null>;
  /**
   * Read `?login_error=` from the URL and stash it in {@link lastLoginError}.
   * Idempotent: a second call finds no param and leaves state untouched.
   */
  captureLoginError(): void;
  /** Return and clear {@link lastLoginError} (consume-on-read). */
  consumeLoginError(): string | null;
  /**
   * Start the GitHub OAuth web flow. Resolves `false` when the instance is
   * unreachable (server down, CORS/network failure) so callers can surface a
   * friendly error instead of dumping the user onto a raw proxy 500 page.
   */
  login(instance: InstanceConfig, returnTo?: string): Promise<boolean>;
  /**
   * Dev-instance login: POST `/auth/dev-session` to provision the fixed test
   * user, then verify via {@link checkAuth}. Returns the profile on success,
   * null when the instance is unreachable or not running AUTH_MODE=dev.
   */
  devLogin(instance: InstanceConfig): Promise<UserProfile | null>;
  logout(instance: InstanceConfig): Promise<void>;
  clearAuth(instanceId: string): void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  authByInstance: {},
  checked: new Set<string>(),
  lastLoginError: null,

  isAuthenticated(instanceId) {
    const profile = get().authByInstance[instanceId];
    return profile !== null && profile !== undefined;
  },

  getProfile(instanceId) {
    return get().authByInstance[instanceId] ?? null;
  },

  captureLoginError() {
    const code = peekLoginError();
    if (code) set({ lastLoginError: code });
  },

  consumeLoginError() {
    const code = get().lastLoginError;
    if (code !== null) set({ lastLoginError: null });
    return code;
  },

  async checkAuth(instance) {
    const baseUrl = instance.baseUrl.replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/api/v1/me`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (response.status === 401) {
        set((state) => ({
          authByInstance: { ...state.authByInstance, [instance.id]: null },
          checked: state.checked.add(instance.id) as Set<string>,
        }));
        return null;
      }
      if (!response.ok) throw new Error(`GET /me failed: ${response.status}`);
      const data = (await response.json()) as MeResponse;
      const profile: UserProfile = { userId: data.id, displayName: data.displayName };
      set((state) => ({
        authByInstance: { ...state.authByInstance, [instance.id]: profile },
        checked: new Set([...state.checked, instance.id]),
      }));
      return profile;
    } catch {
      // Network error — treat as not authenticated rather than crashing the UI.
      set((state) => ({
        authByInstance: { ...state.authByInstance, [instance.id]: null },
        checked: new Set([...state.checked, instance.id]),
      }));
      return null;
    }
  },

  async login(instance: InstanceConfig, returnTo?: string): Promise<boolean> {
    const baseUrl = instance.baseUrl.replace(/\/+$/, '');
    // Pre-flight reachability before redirecting: `/me` answers 401 when the
    // server is healthy but logged out (the expected pre-login state); any
    // other failure means the OAuth entrypoint cannot be reached right now.
    try {
      const response = await fetch(`${baseUrl}/api/v1/me`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (response.status !== 401 && !response.ok) return false;
    } catch {
      return false;
    }
    const path =
      returnTo ??
      (typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/');
    try {
      sessionStorage.setItem(RETURN_TO_KEY, JSON.stringify({ instanceId: instance.id, path }));
    } catch {
      // sessionStorage unavailable — proceed without return-to.
    }
    if (typeof window !== 'undefined') {
      window.location.href = `${baseUrl}/api/v1/auth/github`;
    }
    return true;
  },

  async devLogin(instance: InstanceConfig): Promise<UserProfile | null> {
    const baseUrl = instance.baseUrl.replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/api/v1/auth/dev-session`, {
        method: 'POST',
        credentials: 'include',
        // Fastify rejects an empty body when Content-Type is JSON — send `{}`.
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) return null;
    } catch {
      return null;
    }
    // The dev-session cookie is set — confirm via /me so authByInstance
    // updates and login-gated UI re-renders.
    return get().checkAuth(instance);
  },

  async logout(instance) {
    const baseUrl = instance.baseUrl.replace(/\/+$/, '');
    try {
      await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // The cookie may already be gone — best-effort.
    }
    get().clearAuth(instance.id);
  },

  clearAuth(instanceId) {
    set((state) => {
      const next = { ...state.authByInstance };
      delete next[instanceId];
      const checked = new Set(state.checked);
      checked.delete(instanceId);
      return { authByInstance: next, checked };
    });
  },
}));

// --- Post-login redirect helpers -------------------------------------------

export function consumePostLoginRedirect(): { instanceId: string; path: string } | null {
  try {
    const raw = sessionStorage.getItem(RETURN_TO_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(RETURN_TO_KEY);
    return JSON.parse(raw) as { instanceId: string; path: string };
  } catch {
    return null;
  }
}

export function peekLoginError(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('login_error');
  if (!code) return null;
  // Clean the URL so the error doesn't persist on navigation.
  const url = new URL(window.location.href);
  url.searchParams.delete('login_error');
  window.history.replaceState(null, '', url.toString());
  return code;
}

/** Map a server `login_error` code to a user-facing message. */
export function loginErrorMessage(code: string | null): string | null {
  switch (code) {
    case 'not_allowed':
      return '该实例仅允许白名单内的用户登录。如需使用，请联系实例管理员，或参考 self-hosting 文档自行部署。';
    case 'dev_mode_no_github':
      return '该实例运行在开发模式，请使用开发登录。';
    case 'github_login_failed':
      return 'GitHub 登录失败，请重试。';
    case null:
      return null;
    default:
      return `登录失败（${code}）`;
  }
}
