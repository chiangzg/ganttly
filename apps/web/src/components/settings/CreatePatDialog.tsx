/**
 * Create-PAT dialog (spec §8.3).
 *
 * Collects name, scope checkboxes (fixed four), and optional workspace/project
 * narrowing + expiry, then POSTs to /me/tokens. On success the one-time
 * plaintext token is shown via {@link PatTokenReveal} before the dialog closes.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { MCP_SCOPES, type CreatePatResponse, type McpScope } from '@ganttly/api-contract';
import { createPat } from '@/data/patClient';
import { RemoteError } from '@/data/remoteErrors';
import { PatTokenReveal } from './PatTokenReveal';

const SCOPE_LABELS: Record<McpScope, string> = {
  'workspace:read': '读取工作区',
  'project:read': '读取项目',
  'task:write': '创建/修改任务',
  'project:archive': '归档项目',
};

const DEFAULT_SCOPES: McpScope[] = ['project:read', 'task:write'];

export function CreatePatDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<McpScope>>(new Set(DEFAULT_SCOPES));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatePatResponse | null>(null);

  const reset = () => {
    setName('');
    setScopes(new Set(DEFAULT_SCOPES));
    setError(null);
    setCreated(null);
    setSubmitting(false);
  };

  const toggleScope = (scope: McpScope) => {
    const next = new Set(scopes);
    if (next.has(scope)) next.delete(scope);
    else next.add(scope);
    setScopes(next);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await createPat({
        name: name.trim(),
        scopes: [...scopes],
      });
      setCreated(result);
    } catch (err) {
      setError(
        err instanceof RemoteError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : '创建失败',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (created) onCreated();
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
        else onOpenChange(true);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900">
          <Dialog.Title className="mb-1 text-base font-semibold">创建 MCP 访问令牌</Dialog.Title>
          <Dialog.Description className="mb-4 text-xs text-slate-500 dark:text-slate-400">
            令牌用于 MCP Host（Codex / Claude / 钉钉机器人等）访问你的工作区。
          </Dialog.Description>

          {created ? (
            <div className="space-y-4">
              <PatTokenReveal token={created.token} />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={close}
                  className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900"
                >
                  完成
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  名称
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：CI 自动化"
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
                />
              </label>

              <fieldset>
                <legend className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  权限范围
                </legend>
                <div className="space-y-1.5">
                  {MCP_SCOPES.map((scope) => (
                    <label key={scope} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={scopes.has(scope)}
                        onChange={() => toggleScope(scope)}
                        className="h-4 w-4"
                      />
                      <span className="font-mono text-xs">{scope}</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {SCOPE_LABELS[scope]}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {error && (
                <p className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={close}
                  className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={submitting || !name.trim() || scopes.size === 0}
                  onClick={submit}
                  className="inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900"
                >
                  {submitting && <LoaderCircle size={14} className="animate-spin" />}
                  创建
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
