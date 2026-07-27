import * as Dialog from '@radix-ui/react-dialog';
import { FolderPlus, Upload, X } from 'lucide-react';
import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import type { GanttlyFile } from '@ganttly/schema';
import { parseProjectImport, type ProjectImportKind } from '@/lib/projectImport';

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(name: string, source?: GanttlyFile): Promise<void> | void;
}

export function CreateProjectDialog({ open, onOpenChange, onCreate }: CreateProjectDialogProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const createBlankProject = async (event: FormEvent) => {
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
    setError(null);
    try {
      await onCreate(normalized);
      onOpenChange(false);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const importProject = async (kind: ProjectImportKind, file: File) => {
    setSubmitting(true);
    setError(null);
    try {
      const content = await file.text();
      const result = parseProjectImport(kind, file.name, content);
      await onCreate(result.name, result.file);
      onOpenChange(false);
      if (result.skipped.length > 0) {
        window.alert(
          `已导入 ${result.taskCount} 个任务。以下内容未导入:\n${result.skipped.join('\n')}`,
        );
      }
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      setError(`导入失败：${reason}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFile = (kind: ProjectImportKind, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Reset immediately so choosing the same file again still fires onChange.
    event.currentTarget.value = '';
    if (file) void importProject(kind, file);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting || nextOpen) onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-elevated p-6 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-fg">新建项目</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-muted">
            从空白甘特图开始，或导入一个本地项目文件。
          </Dialog.Description>
          <Dialog.Close
            disabled={submitting}
            className="absolute right-4 top-4 rounded-lg p-1.5 text-fg-muted hover:bg-bg hover:text-fg disabled:opacity-40"
          >
            <X size={17} />
            <span className="sr-only">关闭</span>
          </Dialog.Close>

          <form onSubmit={(event) => void createBlankProject(event)} className="mt-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <FolderPlus size={16} className="text-primary" /> 创建空白项目
            </div>
            <label className="sr-only" htmlFor="new-project-name">
              项目名称
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="new-project-name"
                autoFocus
                value={name}
                maxLength={80}
                disabled={submitting}
                onChange={(event) => setName(event.target.value)}
                placeholder="输入项目名称"
                className="min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={submitting}
                className="shrink-0 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-primary/90 disabled:opacity-50"
              >
                {submitting ? '处理中…' : '创建并打开'}
              </button>
            </div>
          </form>

          <div className="my-5 flex items-center gap-3 text-xs text-fg-muted">
            <span className="h-px flex-1 bg-border" /> 或从本地导入
            <span className="h-px flex-1 bg-border" />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ImportFileControl
              kind="json"
              title="导入 ganttly JSON"
              description="恢复完整任务、资源与项目设置"
              accept=".json,application/json"
              disabled={submitting}
              onChange={handleFile}
            />
            <ImportFileControl
              kind="gan"
              title="导入 GanttProject (.gan)"
              description="导入任务树与任务依赖"
              accept=".gan,.xml,application/xml,text/xml"
              disabled={submitting}
              onChange={handleFile}
            />
          </div>

          <div className="mt-3 min-h-5 text-sm text-danger" role="alert">
            {error}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ImportFileControl({
  kind,
  title,
  description,
  accept,
  disabled,
  onChange,
}: {
  kind: ProjectImportKind;
  title: string;
  description: string;
  accept: string;
  disabled: boolean;
  onChange(kind: ProjectImportKind, event: ChangeEvent<HTMLInputElement>): void;
}) {
  return (
    <label className="relative flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg p-3 transition hover:border-primary/40 hover:bg-primary/5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        aria-label={title}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        onChange={(event) => onChange(kind, event)}
      />
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Upload size={17} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-fg-muted">{description}</span>
      </span>
    </label>
  );
}

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
