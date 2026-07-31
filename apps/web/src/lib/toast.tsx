/**
 * Undo toast — ephemeral notification with an "undo" action button
 * (editor-interaction-optimization-plan §2.4).
 *
 * The toast appears for ~5 seconds after a destructive action (task/resource
 * deletion), allowing the user to undo it with one click. It is a DOM-overlay,
 * not an OS notification — stays within the browser viewport.
 *
 * Usage:
 *   import { showUndoToast } from '@/lib/toast';
 *   showUndoToast('已删除任务: 开发实现', () => store.undo());
 *
 * Multiple toasts stack vertically. Clicking outside a toast dismisses it.
 * Auto-dismiss fires after 5 s of inactivity (paused on hover).
 */
import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

// ---- global toast state (module-scoped, NOT in Zustand) ----
interface ToastEntry {
  id: number;
  message: ReactNode;
  onUndo: () => boolean | void;
}
let nextId = 1;
const listeners: Array<() => void> = [];
let toasts: ToastEntry[] = [];

function emit() {
  for (const fn of listeners) fn();
}

export function showUndoToast(message: ReactNode, onUndo: () => boolean | void) {
  const id = nextId++;
  toasts = [...toasts, { id, message, onUndo }];
  emit();
  // Auto-dismiss after ~5 seconds (the component manages the timer).
}

function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Subscribe to toast changes — used by the React component. */
function subscribeToasts(fn: () => void) {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

// ---- React component ----
const TOAST_DURATION_MS = 5000;

export function UndoToastStack() {
  const [entries, setEntries] = useState<ToastEntry[]>(toasts);

  useEffect(() => {
    return subscribeToasts(() => setEntries([...toasts]));
  }, []);

  if (entries.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-[100] flex flex-col-reverse gap-2">
      {entries.map((t) => (
        <ToastRow key={t.id} entry={t} />
      ))}
    </div>
  );
}

function ToastRow({ entry }: { entry: ToastEntry }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(true);
  const [hovering, setHovering] = useState(false);

  const dismiss = useCallback(() => {
    setVisible(false);
    // Let the fade-out animation run, then actually remove from the list.
    setTimeout(() => dismissToast(entry.id), 200);
  }, [entry.id]);

  // Auto-dismiss after TOAST_DURATION_MS, paused while hovering.
  useEffect(() => {
    if (hovering) return;
    const timer = setTimeout(dismiss, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [hovering, dismiss]);

  return (
    <div
      className={cn(
        'pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-3 shadow-xl transition-all duration-200',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span className="text-sm text-fg">{entry.message}</span>
      <button
        type="button"
        className="rounded-lg bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20"
        onClick={() => {
          entry.onUndo();
          dismiss();
        }}
      >
        {t('toast.undo')}
      </button>
      <button
        type="button"
        className="text-fg-muted hover:text-fg"
        onClick={dismiss}
        aria-label={t('drawer.close')}
      >
        ✕
      </button>
    </div>
  );
}
