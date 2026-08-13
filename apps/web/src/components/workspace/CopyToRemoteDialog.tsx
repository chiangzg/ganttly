/**
 * "复制到远端" dialog (spec §2.4/§12.5).
 *
 * Uploads a local project to a remote workspace as a brand-new, independent
 * copy. The local project is never modified or deleted.
 *
 * Flow: select target instance + workspace → confirm name → preview summary
 * (tasks/deps/resources/baselines) → upload with an idempotency key → navigate
 * to the remote copy.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Check, LoaderCircle, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GanttlyFile } from '@ganttly/schema';
import { createHttpClient } from '@/data/httpClient';
import { copyProjectToRemote } from '@/data/copyToRemote';
import { buildProjectPath } from '@/lib/routing';
import { useInstanceStore } from '@/store/useInstanceStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useScopeStore, type WorkspaceSummary } from '@/store/useScopeStore';

export function CopyToRemoteDialog({
  open,
  onOpenChange,
  sourceFile,
  sourceName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceFile: GanttlyFile;
  sourceName: string;
}) {
  const navigate = useNavigate();
  const customInstances = useInstanceStore((s) => s.customInstances);
  const authByInstance = useAuthStore((s) => s.authByInstance);
  const workspacesByInstance = useScopeStore((s) => s.workspacesByInstance);
  const loadWorkspaces = useScopeStore((s) => s.loadWorkspaces);

  // Authenticated remote instances.
  const remoteInstances = useMemo(() => {
    const official = [
      {
        id: 'official',
        displayName: 'ganttly Cloud',
        baseUrl: window.location.origin,
        kind: 'official' as const,
      },
    ];
    return [...official, ...customInstances].filter((i) => authByInstance[i.id]);
  }, [customInstances, authByInstance]);

  const [selectedInstance, setSelectedInstance] = useState<string>('');
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('');
  const [name, setName] = useState(sourceName);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'error'>('idle');
  const [error, setError] = useState('');
  // Generate once per dialog open; reused across retries.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  // Load workspaces when an instance is selected.
  const handleInstanceChange = async (instanceId: string) => {
    setSelectedInstance(instanceId);
    setSelectedWorkspace('');
    if (!instanceId) return;
    const instance = remoteInstances.find((i) => i.id === instanceId);
    if (!instance) return;
    const workspaces = await loadWorkspaces(instance);
    if (workspaces[0]) setSelectedWorkspace(workspaces[0].id);
  };

  // Summary stats.
  const stats = useMemo(() => {
    const taskCount = sourceFile.tasks.length;
    const depCount = sourceFile.tasks.reduce((sum, t) => sum + t.dependencies.length, 0);
    const resourceCount = sourceFile.resources.length;
    const baselineCount = sourceFile.baselines.length;
    return { taskCount, depCount, resourceCount, baselineCount };
  }, [sourceFile]);

  const workspaces: WorkspaceSummary[] = selectedInstance
    ? (workspacesByInstance[selectedInstance] ?? [])
    : [];

  const reset = () => {
    setSelectedInstance('');
    setSelectedWorkspace('');
    setName(sourceName);
    setStatus('idle');
    setError('');
  };

  const handleUpload = async () => {
    if (!selectedInstance || !selectedWorkspace || !name.trim()) return;
    const instance = remoteInstances.find((i) => i.id === selectedInstance);
    if (!instance) return;
    setStatus('uploading');
    setError('');
    try {
      const httpClient = createHttpClient(instance.baseUrl);
      const ref = await copyProjectToRemote({
        httpClient,
        instanceId: instance.id,
        workspaceId: selectedWorkspace,
        name: name.trim(),
        file: sourceFile,
        sourceClientId: undefined,
        idempotencyKey,
      });
      setStatus('idle');
      onOpenChange(false);
      reset();
      // Navigate to the remote copy. The project center for that scope will
      // refresh automatically on mount.
      navigate(buildProjectPath(ref));
    } catch (err) {
      setStatus('error');
      setError((err as Error).message || '上传失败');
    }
  };

  const canUpload = selectedInstance && selectedWorkspace && name.trim() && status !== 'uploading';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-fg">复制到远端</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-muted">
            上传一份独立副本到远端工作区。本地项目保持不变，两者互不影响。
          </Dialog.Description>

          {remoteInstances.length === 0 ? (
            <div className="mt-5 rounded-xl border border-border bg-bg p-4 text-center text-sm text-fg-muted">
              尚未连接任何远端服务。请先在工作区切换器中登录。
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              {/* Target instance */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-fg-muted">目标实例</label>
                <select
                  value={selectedInstance}
                  onChange={(e) => void handleInstanceChange(e.target.value)}
                  className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none focus:border-primary"
                >
                  <option value="">选择实例…</option>
                  {remoteInstances.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.displayName}
                    </option>
                  ))}
                </select>
              </div>

              {/* Target workspace */}
              {selectedInstance ? (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-fg-muted">
                    目标工作区
                  </label>
                  <select
                    value={selectedWorkspace}
                    onChange={(e) => setSelectedWorkspace(e.target.value)}
                    className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none focus:border-primary"
                  >
                    <option value="">选择工作区…</option>
                    {workspaces.map((ws) => (
                      <option key={ws.id} value={ws.id}>
                        {ws.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {/* Project name */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-fg-muted">项目名称</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none focus:border-primary"
                />
              </div>

              {/* Summary */}
              <div className="grid grid-cols-4 gap-2 rounded-xl border border-border bg-bg p-3 text-center">
                <Stat label="任务" value={stats.taskCount} />
                <Stat label="依赖" value={stats.depCount} />
                <Stat label="资源" value={stats.resourceCount} />
                <Stat label="基线" value={stats.baselineCount} />
              </div>

              {status === 'error' ? <p className="text-sm text-danger">{error}</p> : null}
            </div>
          )}

          {/* Footer */}
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg"
            >
              取消
            </button>
            {remoteInstances.length > 0 ? (
              <button
                type="button"
                onClick={() => void handleUpload()}
                disabled={!canUpload}
                className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {status === 'uploading' ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : status === 'error' ? (
                  <Upload size={15} />
                ) : (
                  <Check size={15} />
                )}
                {status === 'uploading' ? '上传中…' : status === 'error' ? '重试' : '上传并打开'}
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-lg font-bold tabular-nums text-fg">{value}</div>
      <div className="text-xs text-fg-muted">{label}</div>
    </div>
  );
}
