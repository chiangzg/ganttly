/**
 * Global editor keyboard shortcuts (editor-interaction-optimization-plan §4.2).
 *
 * What this hook owns (the truly global, focus-independent shortcuts):
 *   - Cmd/Ctrl+Z              → undo
 *   - Shift+Cmd/Ctrl+Z or Ctrl+Y → redo
 *   - Cmd/Ctrl+S              → save (and suppress the browser "save page" dialog)
 *
 * What it does NOT own: Delete/Enter/F2/Tab/Alt+↑↓/Escape. Those are already
 * handled by the focused row (`TaskTable.onKeyDown`) and the focused canvas
 * (`GanttCanvas.onKeyDown`), and re-binding them here would double-fire. This
 * hook only adds an `isEditableTarget` guard to those existing handlers so a
 * key pressed inside a text input can't bubble up and mis-trigger a task op.
 *
 * Input-target filtering (plan §4.2): undo/redo are *not* intercepted while a
 * text field is focused — the field handles its own undo. Save is the single
 * exception: it fires even from inside an input so the user can always persist.
 *
 * Reads `useProjectStore.getState()` lazily inside the handler (not closed
 * over) to avoid stale state and effect re-subscriptions.
 */
import { useEffect } from 'react';
import { useProjectStore } from '@/store/useProjectStore';
import { isEditableTarget } from '@/lib/shortcutTarget';

export function useEditorShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      // Save — the one shortcut that must fire even from inside a text field.
      if (key === 's') {
        e.preventDefault();
        void useProjectStore.getState().save();
        return;
      }

      // Inside a text-editing element, let the field do its own undo/redo.
      if (isEditableTarget(e.target)) return;

      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useProjectStore.getState().undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        useProjectStore.getState().redo();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
