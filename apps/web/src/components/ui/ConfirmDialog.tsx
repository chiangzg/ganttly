/**
 * General-purpose confirmation dialog (editor-interaction-optimization-plan §2.4).
 *
 * Extracted and made generic from the ProjectDialogs ConfirmDialog so it can be
 * reused for task/resource deletion, dirty-guard discard, and any other
 * confirmation flow. Uses Radix Dialog for consistent keyboard (Escape) and
 * focus management.
 *
 * Unlike the project-specific version, this one supports:
 * - An optional impact line (e.g. "3 subtasks will also be deleted").
 * - A `danger` visual variant for destructive actions.
 * - Focus-return to the trigger element on close.
 */
import { type ReactNode, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

export interface ConfirmDialogProps {
  open: boolean;
  /** Dialog title, e.g. "删除任务" */
  title: string;
  /** Main description row. */
  description: ReactNode;
  /** Optional impact detail shown as a subdued callout (child count, assignment count, etc.). */
  impact?: ReactNode;
  /** Label for the confirm button, e.g. "删除" or "放弃修改". */
  confirmLabel: string;
  /** Cancel button label. Defaults to "取消". */
  cancelLabel?: string;
  /** Render the confirm button in danger red. */
  danger?: boolean;
  onOpenChange(open: boolean): void;
  /** Confirm action. Return a rejected promise to show an inline error. */
  onConfirm(): Promise<void> | void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  impact,
  confirmLabel,
  cancelLabel,
  danger = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none"
          onEscapeKeyDown={(e) => {
            if (submitting) e.preventDefault();
          }}
        >
          <Dialog.Title className="text-lg font-semibold text-fg">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-6 text-fg-muted">
            {description}
          </Dialog.Description>
          {impact ? (
            <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-fg-muted">
              {impact}
            </div>
          ) : null}
          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              disabled={submitting}
              className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg disabled:opacity-50"
            >
              {cancelLabel ?? t('drawer.cancel')}
            </Dialog.Close>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void confirm()}
              className={
                danger
                  ? 'rounded-xl bg-danger px-4 py-2 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50'
                  : 'rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50'
              }
            >
              {submitting ? t('common.processing') : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
