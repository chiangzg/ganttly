/**
 * Right-side edit drawer (PRD §3.10).
 *
 * Slides in from the right when the user double-clicks a task or clicks
 * "new task" in the toolbar. Lets them edit every field on a Task, including
 * dependencies (M2). For MVP it edits the basic fields — name, start, end,
 * duration, progress, milestone, color, note — and dispatches update commands.
 */
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import {
  useProjectStore,
  updateTaskCommand,
  deleteTaskCommand,
  addDependencyCommand,
  deleteDependencyCommand,
} from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import type { Task, DependencyType } from '@ganttly/schema';
import { resolveCalendar, endDateFromDuration, durationBetween } from '@/lib/calendar';
import { getCalendar } from '@ganttly/calendar-data';
import { wouldCreateCycle } from '@/lib/schedule';

const cal = resolveCalendar(getCalendar('zh-CN'));

export function TaskDrawer() {
  const { t } = useTranslation();
  const drawer = useViewStore((s) => s.drawer);
  const closeDrawer = useViewStore((s) => s.closeDrawer);
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const selectedId = file.viewState.selectedTaskId;
  const task = file.tasks.find((x) => x.id === selectedId) ?? null;

  // Local draft so typing is fast; commit on blur / explicit save.
  const [draft, setDraft] = useState<Task | null>(null);
  useEffect(() => {
    setDraft(task);
  }, [task?.id, task]);

  if (drawer === 'closed' || !draft || !task) return null;

  const commit = (patch: Partial<Task>) => {
    if (!task) return;
    dispatch(updateTaskCommand(task.id, patch));
  };

  const deleteTask = () => {
    if (!task) return;
    if (!window.confirm(t('table.confirmDelete'))) return;
    dispatch(deleteTaskCommand(task.id));
    closeDrawer();
  };

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-80 flex-col border-l border-border bg-bg-elevated shadow-lg">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{t('drawer.title')}</h2>
        <button onClick={closeDrawer} className="text-fg-muted hover:text-fg">
          ✕
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        <Field label={t('drawer.name')}>
          <input
            className="input"
            value={draft.name}
            onChange={(e) => {
              const v = e.target.value;
              setDraft({ ...draft, name: v });
              commit({ name: v });
            }}
          />
        </Field>
        <Field label={t('drawer.start')}>
          <input
            type="date"
            className="input"
            value={draft.start}
            onChange={(e) => {
              const start = e.target.value;
              const end = endDateFromDuration(start, draft.duration || 1, cal);
              const patch = { start, end, duration: durationBetween(start, end, cal) };
              setDraft({ ...draft, ...patch });
              commit(patch);
            }}
          />
        </Field>
        <Field label={t('drawer.end')}>
          <input
            type="date"
            className="input"
            value={draft.end}
            onChange={(e) => {
              const end = e.target.value;
              const duration = durationBetween(draft.start, end, cal);
              const patch = { end, duration: Math.max(0, duration) };
              setDraft({ ...draft, ...patch });
              commit(patch);
            }}
          />
        </Field>
        <Field label={t('drawer.duration')}>
          <input
            type="number"
            min={0}
            className="input"
            value={draft.duration}
            onChange={(e) => {
              const duration = Math.max(0, Number(e.target.value) || 0);
              const end = endDateFromDuration(draft.start, duration, cal);
              const patch = { duration, end };
              setDraft({ ...draft, ...patch });
              commit(patch);
            }}
          />
        </Field>
        <Field label={t('drawer.progress')}>
          <input
            type="range"
            min={0}
            max={100}
            value={draft.progress}
            onChange={(e) => {
              const progress = Number(e.target.value);
              setDraft({ ...draft, progress });
              commit({ progress });
            }}
          />
          <span className="ml-2 tabular-nums">{draft.progress}%</span>
        </Field>
        <Field label={t('drawer.milestone')}>
          <input
            type="checkbox"
            checked={draft.isMilestone}
            onChange={(e) => {
              const isMilestone = e.target.checked;
              const patch: Partial<Task> = { isMilestone };
              if (isMilestone) {
                patch.duration = 0;
                patch.end = draft.start;
                patch.progress = draft.progress === 0 ? 100 : draft.progress;
              }
              setDraft({ ...draft, ...patch });
              commit(patch);
            }}
          />
        </Field>
        <Field label={t('drawer.color')}>
          <input
            type="color"
            value={draft.color ?? '#60a5fa'}
            onChange={(e) => {
              const color = e.target.value;
              setDraft({ ...draft, color });
              commit({ color });
            }}
          />
        </Field>
        <Field label={t('drawer.note')}>
          <textarea
            className="input min-h-24"
            value={draft.note ?? ''}
            onChange={(e) => {
              const note = e.target.value;
              setDraft({ ...draft, note });
              commit({ note });
            }}
          />
        </Field>
        <Field label={t('drawer.dependencies')}>
          <div className="space-y-2">
            {task.dependencies.map((dep) => {
              const pred = file.tasks.find((x) => x.id === dep.targetId);
              return (
                <div key={dep.targetId} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-xs">{pred?.name ?? dep.targetId}</span>
                  <span className="text-xs text-fg-muted">{dep.type}</span>
                  <span className="text-xs text-fg-muted">lag={dep.lag}</span>
                  <button
                    onClick={() => dispatch(deleteDependencyCommand(task.id, dep.targetId))}
                    className="text-danger hover:underline"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            <DependencyAdder
              successorId={task.id}
              existingTargetIds={task.dependencies.map((d) => d.targetId)}
              candidates={file.tasks.filter((x) => x.id !== task.id)}
              onAdd={(targetId, type, lag) => {
                if (
                  wouldCreateCycle(file.tasks, {
                    successorId: task.id,
                    predecessorId: targetId,
                  })
                ) {
                  window.alert(t('errors.cycleDetected'));
                  return;
                }
                dispatch(addDependencyCommand(task.id, { targetId, type, lag }));
              }}
            />
          </div>
        </Field>
      </div>
      <div className="flex gap-2 border-t border-border p-3">
        <button onClick={deleteTask} className="btn-danger flex-1">
          {t('drawer.delete')}
        </button>
        <button onClick={closeDrawer} className="btn flex-1">
          {t('drawer.cancel')}
        </button>
      </div>

      {/* Local style helpers — kept inline to avoid creating one file per component in M1. */}
      <style>{`
        .input {
          width: 100%;
          padding: 6px 8px;
          background: rgb(var(--color-bg));
          border: 1px solid rgb(var(--color-border));
          border-radius: 4px;
          color: rgb(var(--color-fg));
          font-size: 13px;
        }
        .btn {
          padding: 6px 12px;
          background: rgb(var(--color-bg));
          border: 1px solid rgb(var(--color-border));
          border-radius: 4px;
          color: rgb(var(--color-fg));
          font-size: 13px;
          cursor: pointer;
        }
        .btn:hover { background: rgb(var(--color-bg-elevated)); }
        .btn-danger {
          padding: 6px 12px;
          background: rgb(var(--color-danger));
          border: 1px solid rgb(var(--color-danger));
          border-radius: 4px;
          color: white;
          font-size: 13px;
          cursor: pointer;
        }
      `}</style>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

function DependencyAdder({
  successorId,
  existingTargetIds,
  candidates,
  onAdd,
}: {
  successorId: string;
  existingTargetIds: string[];
  candidates: Task[];
  onAdd: (targetId: string, type: DependencyType, lag: number) => void;
}) {
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState('');
  const [type, setType] = useState<DependencyType>('FS');
  const [lag, setLag] = useState(0);
  void successorId;

  const available = candidates.filter((c) => !existingTargetIds.includes(c.id));

  return (
    <div className="flex items-center gap-2 text-xs">
      <select
        className="input flex-1"
        value={targetId}
        onChange={(e) => setTargetId(e.target.value)}
      >
        <option value="">{t('drawer.addDependency')}</option>
        {available.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name || c.id}
          </option>
        ))}
      </select>
      <select
        className="input w-16"
        value={type}
        onChange={(e) => setType(e.target.value as DependencyType)}
      >
        <option value="FS">FS</option>
        <option value="SS">SS</option>
        <option value="FF">FF</option>
        <option value="SF">SF</option>
      </select>
      <input
        type="number"
        className="input w-14"
        value={lag}
        onChange={(e) => setLag(Number(e.target.value) || 0)}
      />
      <button
        className="btn px-2"
        disabled={!targetId}
        onClick={() => {
          if (!targetId) return;
          onAdd(targetId, type, lag);
          setTargetId('');
        }}
      >
        +
      </button>
    </div>
  );
}
