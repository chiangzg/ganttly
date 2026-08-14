/**
 * Persistent "remote has updates" banner (spec §11.3 case b).
 *
 * Shown when the SSE stream reported a change to the currently-open remote
 * project while it had unsaved local edits. The local copy is never silently
 * overwritten; the user chooses to reload (discarding local edits) or keep
 * editing. Hidden automatically once the project is reloaded.
 */
import { RefreshCw } from 'lucide-react';
import { useProjectStore } from '@/store/useProjectStore';

export function RemoteUpdateBanner() {
  const remoteUpdateAvailable = useProjectStore((s) => s.remoteUpdateAvailable);
  const reloadFromRemote = useProjectStore((s) => s.reloadFromRemote);

  if (!remoteUpdateAvailable) return null;

  const handleReload = () => {
    // reloadFromRemote discards local edits and clears the flag on success.
    void reloadFromRemote();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300/60 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <span>远端有更新。本地仍有未保存的修改，未自动覆盖以免丢失你的编辑。</span>
      <button
        type="button"
        onClick={handleReload}
        className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-amber-700"
      >
        <RefreshCw size={13} /> 重新加载
      </button>
    </div>
  );
}
