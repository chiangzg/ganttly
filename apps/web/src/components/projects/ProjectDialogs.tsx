import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

interface ProjectNameDialogProps {
  open: boolean;
  title: string;
  description?: string;
  initialValue?: string;
  submitLabel: string;
  onOpenChange(open: boolean): void;
  onSubmit(name: string): Promise<void> | void;
}

export function ProjectNameDialog({
  open,
  title,
  description,
  initialValue = '',
  submitLabel,
  onOpenChange,
  onSubmit,
}: ProjectNameDialogProps) {
  const [name, setName] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialValue);
      setError(null);
    }
  }, [initialValue, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = name.trim();
    if (!normalized) {
      setError('项目名称不能为空');
      return;
    }
    if (normalized.length > 80) {
      setError('项目名称不能超过 80 个字符');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(normalized);
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-fg">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="mt-1 text-sm text-fg-muted">
              {description}
            </Dialog.Description>
          ) : null}
          <Dialog.Close className="absolute right-4 top-4 rounded-lg p-1.5 text-fg-muted hover:bg-bg hover:text-fg">
            <X size={17} />
            <span className="sr-only">关闭</span>
          </Dialog.Close>
          <form onSubmit={(event) => void submit(event)} className="mt-5">
            <label className="text-sm font-medium text-fg" htmlFor="project-name">
              项目名称
            </label>
            <input
              id="project-name"
              autoFocus
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-1 flex min-h-5 justify-between text-xs">
              <span className="text-danger">{error}</span>
              <span className="text-fg-muted">{name.trim().length}/80</span>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg">
                取消
              </Dialog.Close>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary/90 disabled:opacity-50"
              >
                {submitting ? '处理中…' : submitLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): Promise<void> | void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-fg">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-6 text-fg-muted">
            {description}
          </Dialog.Description>
          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg">
              取消
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
              {submitting ? '处理中…' : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
