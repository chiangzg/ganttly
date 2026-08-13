/**
 * "添加远端服务" dialog (spec §2.2).
 *
 * The user enters an HTTPS URL, the client fetches
 * `/.well-known/ganttly-instance` and validates the descriptor via Zod. On
 * success the instance is registered; on failure (non-HTTPS, incompatible
 * protocol, unreachable) an inline error is shown and no login flow starts.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Globe, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { InstanceDiscoveryError, useInstanceStore } from '@/store/useInstanceStore';

export function AddInstanceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  const reset = () => {
    setUrl('');
    setStatus('idle');
    setError('');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setStatus('loading');
    setError('');
    try {
      await useInstanceStore.getState().addCustomInstance(url);
      setStatus('idle');
      setUrl('');
      onOpenChange(false);
    } catch (err) {
      setStatus('error');
      setError(err instanceof InstanceDiscoveryError ? err.message : '添加失败，请检查地址后重试');
    }
  };

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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-fg">添加远端服务</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-muted">
            输入自建 ganttly 实例的 HTTPS 地址。我们将验证服务协议后添加。
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-5 space-y-3">
            <div className="relative">
              <Globe size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
              <input
                autoFocus
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (status === 'error') setStatus('idle');
                }}
                placeholder="https://gan.your-company.com"
                className="w-full rounded-xl border border-border bg-bg py-2.5 pl-10 pr-3 text-sm text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {status === 'error' ? <p className="text-sm text-danger">{error}</p> : null}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={status === 'loading' || !url.trim()}
                className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {status === 'loading' ? <LoaderCircle size={15} className="animate-spin" /> : null}
                添加
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
