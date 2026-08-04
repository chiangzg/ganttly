/**
 * BatchActionBar — floating multi-selection action bar (plan §4.6). Appears at
 * the bottom centre of the editor content row whenever ≥2 tasks are selected
 * (the selection set is shared by the table and the canvas). Currently hosts
 * the batch owner assignment entry point; other batch actions (progress, move)
 * are deliberately out of scope for this PR.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useViewStore } from '@/store/useViewStore';
import { BatchAssignPopover } from './BatchAssignPopover';

export function BatchActionBar() {
  const { t } = useTranslation();
  const selectedTaskIds = useViewStore((s) => s.selectedTaskIds);
  const clearSelection = useViewStore((s) => s.clearSelection);
  const [assignOpen, setAssignOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const count = selectedTaskIds.size;
  if (count < 2) return null;

  return (
    <div ref={barRef} data-batch-bar className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
      <BatchAssignPopover open={assignOpen} onClose={() => setAssignOpen(false)} />
      <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-1.5 shadow-lg">
        <span className="text-xs text-fg-muted">{t('batch.selectedCount', { count })}</span>
        <button
          type="button"
          onClick={() => setAssignOpen((v) => !v)}
          className="flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-white shadow-sm outline-none transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/35"
        >
          {t('batch.assignAssignee')}
        </button>
        <button
          type="button"
          aria-label={t('batch.clearSelection')}
          title={t('batch.clearSelection')}
          onClick={clearSelection}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted outline-none transition hover:bg-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/35"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
