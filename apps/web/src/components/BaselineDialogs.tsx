/**
 * Baseline dialogs — create / manage / rename / delete (baseline-comparison
 * spec §5.4, §5.5, §4.1, §4.3, §4.4).
 *
 * Dialog state (open flags, form drafts) lives in component-local state. Only
 * `useViewStore.activeBaselineId` and `useProjectStore.file.baselines` are
 * global; no new store is introduced (spec §6.8).
 *
 * Naming rules (spec §2.2):
 * - Default `计划基线 N` where N is the first unused positive integer.
 * - Trimmed name must be non-empty.
 * - UI max 40 chars.
 * - Unique within the project; comparison ignores ASCII case but keeps Chinese
 *   as-is. Existing imported names longer than 40 chars are NOT rejected on
 *   load (handled by import), but the UI clamps new input to 40.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Pencil, Trash2, Eye } from 'lucide-react';
import { nanoid } from 'nanoid';
import type { Baseline } from '@ganttly/schema';
import {
  useProjectStore,
  createBaselineCommand,
  renameBaselineCommand,
  deleteBaselineCommand,
} from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { createBaselineSnapshot } from '@/lib/baseline';
import { useBaselineSelection } from './useBaselineSelection';

const NAME_MAX = 40;

/** First unused positive integer for the default name (spec §2.2). Matches both
 * the zh (`计划基线 N`) and en (`Baseline N`) default-name prefixes. */
export function nextBaselineNumber(baselines: ReadonlyArray<Baseline>): number {
  const used = new Set<number>();
  for (const b of baselines) {
    const m = /^(计划基线|Baseline)\s+(\d+)$/.exec(b.name.trim());
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/**
 * Validate a baseline name (spec §2.2). Returns an i18n KEY (translated at the
 * call site via `t(err)`) or null when valid. Uniqueness ignores ASCII case;
 * Chinese compared as-is.
 */
export function validateBaselineName(
  name: string,
  baselines: ReadonlyArray<Baseline>,
  exceptId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'baseline.nameEmpty';
  if (trimmed.length > NAME_MAX) return 'baseline.nameTooLong';
  const lower = trimmed.toLowerCase();
  for (const b of baselines) {
    if (exceptId && b.id === exceptId) continue;
    if (b.name.trim().toLowerCase() === lower) return 'baseline.nameDuplicate';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Create dialog (spec §5.4)
// ---------------------------------------------------------------------------

interface CreateBaselineDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function CreateBaselineDialog({ open, onOpenChange }: CreateBaselineDialogProps) {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const selectBaseline = useBaselineSelection();

  const defaultName = t('baseline.defaultName', {
    n: nextBaselineNumber(file.baselines),
  });
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(t('baseline.defaultName', { n: nextBaselineNumber(file.baselines) }));
      setError(null);
    }
  }, [open, file.baselines, t]);

  const taskCount = file.tasks.length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const err = validateBaselineName(name, file.baselines);
    if (err) {
      setError(t(err));
      return;
    }
    // Capture the snapshot from the CURRENT file state, then dispatch + activate.
    const baseline = createBaselineSnapshot(file, {
      id: nanoid(10),
      name: name.trim(),
      capturedAt: new Date().toISOString(),
    });
    dispatch(createBaselineCommand(baseline));
    selectBaseline(baseline.id, baseline); // spec §4.1.5 — auto-activate new baseline
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-fg">
            {t('baseline.saveTitle')}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-muted">
            {t('baseline.saveDescription')}
          </Dialog.Description>
          <Dialog.Close className="absolute right-4 top-4 rounded-lg p-1.5 text-fg-muted hover:bg-bg hover:text-fg">
            <X size={17} />
            <span className="sr-only">{t('common.close')}</span>
          </Dialog.Close>
          <form onSubmit={submit} className="mt-5">
            <label className="text-sm font-medium text-fg" htmlFor="baseline-name">
              {t('baseline.nameLabel')}
            </label>
            <input
              id="baseline-name"
              autoFocus
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-1 flex min-h-5 justify-between text-xs">
              <span className="text-danger">{error}</span>
              <span className="text-fg-muted">
                {name.trim().length}/{NAME_MAX}
              </span>
            </div>
            <p className="mt-3 text-xs text-fg-muted">
              {t('baseline.savingTasksHint', { count: taskCount })}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg">
                {t('common.cancel')}
              </Dialog.Close>
              <button
                type="submit"
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary/90"
              >
                {t('baseline.saveAndCompare')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Rename dialog (spec §4.3 — same validation as create)
// ---------------------------------------------------------------------------

interface RenameBaselineDialogProps {
  baseline: Baseline | null;
  onOpenChange(open: boolean): void;
}

export function RenameBaselineDialog({ baseline, onOpenChange }: RenameBaselineDialogProps) {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (baseline) {
      setName(baseline.name);
      setError(null);
    }
  }, [baseline]);

  if (!baseline) return null;
  const open = baseline !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const err = validateBaselineName(name, file.baselines, baseline.id);
    if (err) {
      setError(t(err));
      return;
    }
    dispatch(renameBaselineCommand(baseline.id, name.trim()));
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-fg">
            {t('baseline.renameTitle')}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-muted">
            {t('baseline.renameDescription')}
          </Dialog.Description>
          <Dialog.Close className="absolute right-4 top-4 rounded-lg p-1.5 text-fg-muted hover:bg-bg hover:text-fg">
            <X size={17} />
            <span className="sr-only">{t('common.close')}</span>
          </Dialog.Close>
          <form onSubmit={submit} className="mt-5">
            <label className="text-sm font-medium text-fg" htmlFor="rename-baseline-name">
              {t('baseline.nameLabel')}
            </label>
            <input
              id="rename-baseline-name"
              autoFocus
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-1 flex min-h-5 justify-between text-xs">
              <span className="text-danger">{error}</span>
              <span className="text-fg-muted">
                {name.trim().length}/{NAME_MAX}
              </span>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg">
                {t('common.cancel')}
              </Dialog.Close>
              <button
                type="submit"
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary/90"
              >
                {t('common.save')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm (spec §4.4 — "只删除基线，不修改当前任务")
// ---------------------------------------------------------------------------

interface DeleteBaselineDialogProps {
  baseline: Baseline | null;
  onOpenChange(open: boolean): void;
  onSelectBaseline(id: string | null): void;
}

export function DeleteBaselineDialog({
  baseline,
  onOpenChange,
  onSelectBaseline,
}: DeleteBaselineDialogProps) {
  const { t } = useTranslation();
  const dispatch = useProjectStore((s) => s.dispatch);
  const activeBaselineId = useViewStore((s) => s.activeBaselineId);

  if (!baseline) return null;
  const open = baseline !== null;
  const isActive = activeBaselineId === baseline.id;

  const confirm = () => {
    // Spec §4.4 / §7: deleting the active baseline exits comparison FIRST,
    // then removes the snapshot. Exit is ephemeral UI state (not a command).
    if (isActive) onSelectBaseline(null);
    dispatch(deleteBaselineCommand(baseline.id));
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-fg">
            {t('baseline.deleteTitle')}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-6 text-fg-muted">
            {t(isActive ? 'baseline.deleteConfirmActive' : 'baseline.deleteConfirm', {
              name: baseline.name,
            })}
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg">
              {t('common.cancel')}
            </Dialog.Close>
            <button
              type="button"
              onClick={confirm}
              className="rounded-xl bg-danger px-4 py-2 text-sm font-medium text-white hover:bg-danger/90"
            >
              {t('drawer.delete')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Manage dialog (spec §5.5)
// ---------------------------------------------------------------------------

interface ManageBaselinesDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(): void;
  onRename(baseline: Baseline): void;
  onDelete(baseline: Baseline): void;
  onSelectBaseline(id: string | null): void;
}

export function ManageBaselinesDialog({
  open,
  onOpenChange,
  onCreate,
  onRename,
  onDelete,
  onSelectBaseline,
}: ManageBaselinesDialogProps) {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const activeBaselineId = useViewStore((s) => s.activeBaselineId);

  // Newest first by capturedAt (spec §2.1).
  const sorted = [...file.baselines].sort((a, b) =>
    a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-64px)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-fg">
            {t('baseline.manageTitle')}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-muted">
            {t('baseline.manageDescription')}
          </Dialog.Description>
          <Dialog.Close className="absolute right-4 top-4 rounded-lg p-1.5 text-fg-muted hover:bg-bg hover:text-fg">
            <X size={17} />
            <span className="sr-only">{t('common.close')}</span>
          </Dialog.Close>

          {sorted.length === 0 ? (
            <div className="mt-8 flex flex-col items-center gap-4 py-10 text-center">
              <p className="text-sm text-fg-muted">{t('baseline.manageEmpty')}</p>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onCreate();
                }}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
              >
                {t('toolbar.createBaseline')}
              </button>
            </div>
          ) : (
            <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
              {/* Header row */}
              <div className="grid grid-cols-[minmax(0,1fr)_140px_64px_120px] gap-2 border-b border-border pb-2 text-xs font-medium text-fg-muted">
                <span>{t('baseline.columnName')}</span>
                <span>{t('baseline.columnCapturedAt')}</span>
                <span className="text-right">{t('baseline.columnTaskCount')}</span>
                <span className="text-right">{t('baseline.columnActions')}</span>
              </div>
              <ul className="divide-y divide-border">
                {sorted.map((b) => {
                  const isActive = activeBaselineId === b.id;
                  const captured = b.capturedAt.slice(0, 16).replace('T', ' ');
                  return (
                    <li
                      key={b.id}
                      className="grid grid-cols-[minmax(0,1fr)_140px_64px_120px] items-center gap-2 py-2.5 text-sm"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-fg" title={b.name}>
                          {b.name}
                        </span>
                        {isActive ? (
                          <span className="shrink-0 text-[11px] text-primary">
                            {t('baseline.comparing')}
                          </span>
                        ) : null}
                      </span>
                      <span className="truncate text-xs text-fg-muted" title={captured}>
                        {captured}
                      </span>
                      <span className="text-right tabular-nums text-fg-muted">
                        {b.tasks.length}
                      </span>
                      <span className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onSelectBaseline(isActive ? null : b.id)}
                          aria-label={
                            isActive ? t('baseline.stopCompare') : t('baseline.startCompare')
                          }
                          title={
                            isActive ? t('baseline.stopCompareShort') : t('baseline.compareShort')
                          }
                          className="rounded-lg p-1.5 text-fg-muted hover:bg-bg hover:text-fg"
                        >
                          <Eye size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onRename(b)}
                          aria-label={t('baseline.renameAria', { name: b.name })}
                          title={t('baseline.renameShort')}
                          className="rounded-lg p-1.5 text-fg-muted hover:bg-bg hover:text-fg"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(b)}
                          aria-label={t('baseline.deleteAria', { name: b.name })}
                          title={t('drawer.delete')}
                          className="rounded-lg p-1.5 text-danger hover:bg-danger/10"
                        >
                          <Trash2 size={15} />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onCreate();
              }}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
            >
              {t('baseline.saveAsBaseline')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
