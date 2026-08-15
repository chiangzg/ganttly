/**
 * PAT settings page (spec §8.3).
 *
 * Lists the user's Personal Access Tokens for the official instance, lets them
 * create new ones (with a one-time token reveal) and revoke existing ones.
 * Requires an authenticated session on the official instance; unauthenticated
 * visitors are prompted to connect.
 */
import { KeyRound, LoaderCircle, LogIn, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { PatSummary } from '@ganttly/api-contract';
import { listPats, revokePat } from '@/data/patClient';
import { RemoteError } from '@/data/remoteErrors';
import { useAuthStore } from '@/store/useAuthStore';
import { officialInstance } from '@/store/useInstanceStore';
import { CreatePatDialog } from './CreatePatDialog';

export function PatSettings() {
  const instance = officialInstance();
  const profile = useAuthStore((s) => s.getProfile(instance.id));
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const login = useAuthStore((s) => s.login);
  const [tokens, setTokens] = useState<PatSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Ensure auth status is known before deciding to prompt for login.
  useEffect(() => {
    if (profile === null) void checkAuth(instance);
  }, [instance, profile, checkAuth]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTokens(await listPats());
    } catch (err) {
      setError(
        err instanceof RemoteError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : '加载失败',
      );
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profile) void refresh();
  }, [profile, refresh]);

  if (!profile) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-sm rounded-3xl border border-border bg-bg-elevated p-8 text-center shadow-xl">
          <h2 className="text-lg font-semibold text-fg">连接到 {instance.displayName}</h2>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            使用 GitHub 登录后即可管理 MCP 访问令牌。
          </p>
          <button
            type="button"
            onClick={() => login(instance, '/settings/tokens')}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
          >
            <LogIn size={16} /> 连接 GitHub
          </button>
        </div>
      </div>
    );
  }

  const handleRevoke = async (patId: string) => {
    setRevokingId(patId);
    try {
      await revokePat(patId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销失败');
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={18} className="text-slate-500" />
          <h1 className="text-lg font-semibold">MCP 访问令牌</h1>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900"
        >
          <Plus size={14} />
          创建令牌
        </button>
      </header>

      {error && (
        <p className="mb-3 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {loading && tokens === null ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <LoaderCircle size={16} className="animate-spin" />
          加载中…
        </div>
      ) : tokens && tokens.length > 0 ? (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {tokens.map((pat) => (
            <li key={pat.id} className="flex items-center justify-between px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{pat.name}</span>
                  {pat.revokedAt && (
                    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                      已撤销
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  <span>{pat.tokenPrefix}…</span>
                  <span>·</span>
                  <span>{pat.scopes.join(', ')}</span>
                  {pat.expiresAt && (
                    <>
                      <span>·</span>
                      <span>过期 {new Date(pat.expiresAt).toLocaleDateString()}</span>
                    </>
                  )}
                  {pat.lastUsedAt && (
                    <>
                      <span>·</span>
                      <span>最近使用 {new Date(pat.lastUsedAt).toLocaleDateString()}</span>
                    </>
                  )}
                </div>
              </div>
              {!pat.revokedAt && (
                <button
                  type="button"
                  onClick={() => void handleRevoke(pat.id)}
                  disabled={revokingId === pat.id}
                  title="撤销"
                  className="ml-2 inline-flex shrink-0 items-center rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950"
                >
                  {revokingId === pat.id ? (
                    <LoaderCircle size={15} className="animate-spin" />
                  ) : (
                    <Trash2 size={15} />
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        tokens && (
          <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-700">
            还没有访问令牌。创建一个以连接 MCP Host。
          </p>
        )
      )}

      <CreatePatDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void refresh()}
      />
    </div>
  );
}
