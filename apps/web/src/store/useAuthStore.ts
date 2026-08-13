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

  isAuthenticated(instanceId: string): boolean;
  getProfile(instanceId: string): UserProfile | null;
  checkAuth(instance: InstanceConfig): Promise<UserProfile | null>;
  login(instance: InstanceConfig, returnTo?: string): void;
  logout(instance: InstanceConfig): Promise<void>;
  clearAuth(instanceId: string): void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  authByInstance: {},
  checked: new Set<string>(),

  isAuthenticated(instanceId) {
    const profile = get().authByInstance[instanceId];
    return profile !== null && profile !== undefined;
  },

  getProfile(instanceId) {
    return get().authByInstance[instanceId] ?? null;
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

  login(instance, returnTo) {
    const path =
      returnTo ??
      (typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/');
    try {
      sessionStorage.setItem(RETURN_TO_KEY, JSON.stringify({ instanceId: instance.id, path }));
    } catch {
      // sessionStorage unavailable — proceed without return-to.
    }
    const baseUrl = instance.baseUrl.replace(/\/+$/, '');
    if (typeof window !== 'undefined') {
      window.location.href = `${baseUrl}/api/v1/auth/github`;
    }
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
