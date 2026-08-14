/**
 * One-time PAT plaintext display (spec §8.3).
 *
 * The full token is returned exactly once at creation and never persisted or
 * re-fetchable. This component shows it with a copy button and a clear warning
 * that closing loses access to it.
 */
import { useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';

export function PatTokenReveal({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); the user can still
      // select-and-copy manually from the readonly field.
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>
          此令牌仅显示一次。关闭后无法再次查看，请立即复制保存。数据库仅保留哈希，无法恢复。
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={token}
          className="flex-1 rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          onClick={copy}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium',
            copied
              ? 'bg-green-600 text-white'
              : 'bg-slate-800 text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-slate-300',
          )}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  );
}
