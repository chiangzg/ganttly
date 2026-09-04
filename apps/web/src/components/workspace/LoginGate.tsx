/**
 * Inline login prompt shown when the active scope is a remote instance that
 * the user has not yet authenticated with (spec §12.3).
 *
 * Replaces the project grid with a centered card offering the GitHub OAuth
 * entry point. The actual redirect happens in `authStore.login`. Instances
 * that advertise `auth.devLogin` (AUTH_MODE=dev, local testing) instead get
 * a one-click dev-session button — the GitHub flow always fails there.
 */
import { Cloud, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, loginErrorMessage } from '@/store/useAuthStore';
import { fetchInstanceDiscovery, useInstanceStore } from '@/store/useInstanceStore';
import { useScopeStore } from '@/store/useScopeStore';
import { buildScopePath, LOCAL_SCOPE } from '@/lib/routing';

export function LoginGate({
  instanceId: instanceIdProp,
  returnTo,
}: {
  /** Target instance; defaults to the active scope. The editor deep-link route
   * must pass this explicitly — on a fresh reload the scope store still sits
   * on the local workspace while the URL points at a remote instance. */
  instanceId?: string;
  /** Where to return after login; defaults to the active scope's project
   * center path (editor route passes the deep-linked project path). */
  returnTo?: string;
} = {}) {
  const activeScope = useScopeStore((s) => s.activeScope);
  const findInstance = useInstanceStore((s) => s.findInstance);
  const navigate = useNavigate();
  const [loginError, setLoginError] = useState<string | null>(null);
  const [devCapable, setDevCapable] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);

  const instanceId = instanceIdProp ?? activeScope.instanceId;
  const instance = findInstance(instanceId);
  const instanceUrl = instance?.baseUrl ?? '';

  useEffect(() => {
    // Surface the server-reported `?login_error=` reason (e.g. an allowlist
    // denial) in the error slot below. Consumed once; PostLoginRedirect
    // normally shows it first on the OAuth round-trip path — this covers
    // mounts that skip that route.
    const code = useAuthStore.getState().consumeLoginError();
    if (code) setLoginError(loginErrorMessage(code));
  }, []);

  useEffect(() => {
    // Keyed on primitives: officialInstance() builds a fresh object per
    // render, so an object dep would re-run this effect every render.
    if (!instanceId || !instanceUrl) return;
    const current = useInstanceStore.getState().findInstance(instanceId);
    if (!current) return;
    let cancelled = false;
    // The session cookie outlives a page reload (auth state is memory-only)
    // — re-check it first so a valid session skips the login prompt entirely.
    void useAuthStore.getState().checkAuth(current);
    void fetchInstanceDiscovery({ baseUrl: instanceUrl }).then((discovery) => {
      if (!cancelled) setDevCapable(Boolean(discovery?.auth.devLogin));
    });
    return () => {
      cancelled = true;
    };
  }, [instanceId, instanceUrl]);

  if (!instance) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-fg-muted">
        实例不可用
      </div>
    );
  }

  const handleDevLogin = async () => {
    setLoginError(null);
    setLoggingIn(true);
    try {
      const profile = await useAuthStore.getState().devLogin(instance);
      if (!profile) {
        setLoginError('开发登录失败，请确认服务状态');
        return;
      }
      if (returnTo) {
        navigate(returnTo, { replace: true });
        return;
      }
      const workspaces = await useScopeStore.getState().loadWorkspaces(instance);
      const first = workspaces[0];
      navigate(
        first
          ? buildScopePath({ instanceId: instance.id, workspaceId: first.id })
          : buildScopePath(LOCAL_SCOPE),
        { replace: true },
      );
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogin = async () => {
    setLoginError(null);
    const started = await useAuthStore
      .getState()
      .login(
        instance,
        returnTo ??
          buildScopePath({ instanceId: instance.id, workspaceId: activeScope.workspaceId }),
      );
    if (!started) {
      setLoginError(`无法连接 ${instance.displayName}，请确认服务已启动`);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-sm rounded-3xl border border-border bg-bg-elevated p-8 text-center shadow-xl">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Cloud size={25} />
        </span>
        <h2 className="mt-5 text-lg font-semibold text-fg">连接到 {instance.displayName}</h2>
        <p className="mt-2 text-sm leading-6 text-fg-muted">
          {devCapable
            ? '该实例运行在开发模式，可直接建立测试会话。'
            : '使用 GitHub 登录以访问该工作区的项目。你的凭证仅在此实例上验证，不经过 ganttly 本地。'}
        </p>
        {devCapable ? (
          <button
            type="button"
            disabled={loggingIn}
            onClick={() => void handleDevLogin()}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-60"
          >
            <LogIn size={16} /> {loggingIn ? '正在登录…' : '开发登录'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleLogin()}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
          >
            <LogIn size={16} /> 连接 GitHub
          </button>
        )}
        {loginError ? <p className="mt-3 text-xs text-danger">{loginError}</p> : null}
      </div>
    </div>
  );
}
