/**
 * Inline login prompt shown when the active scope is a remote instance that
 * the user has not yet authenticated with (spec §12.3).
 *
 * Replaces the project grid with a centered card offering the GitHub OAuth
 * entry point. The actual redirect happens in `authStore.login`.
 */
import { Cloud, LogIn } from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { useInstanceStore } from '@/store/useInstanceStore';
import { useScopeStore } from '@/store/useScopeStore';
import { buildScopePath } from '@/lib/routing';

export function LoginGate() {
  const activeScope = useScopeStore((s) => s.activeScope);
  const findInstance = useInstanceStore((s) => s.findInstance);

  const instance = findInstance(activeScope.instanceId);
  if (!instance) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-fg-muted">
        实例不可用
      </div>
    );
  }

  const handleLogin = () => {
    useAuthStore
      .getState()
      .login(
        instance,
        buildScopePath({ instanceId: instance.id, workspaceId: activeScope.workspaceId }),
      );
  };

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-sm rounded-3xl border border-border bg-bg-elevated p-8 text-center shadow-xl">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Cloud size={25} />
        </span>
        <h2 className="mt-5 text-lg font-semibold text-fg">连接到 {instance.displayName}</h2>
        <p className="mt-2 text-sm leading-6 text-fg-muted">
          使用 GitHub 登录以访问该工作区的项目。你的凭证仅在此实例上验证，不经过 ganttly 本地。
        </p>
        <button
          type="button"
          onClick={handleLogin}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
        >
          <LogIn size={16} /> 连接 GitHub
        </button>
      </div>
    </div>
  );
}
