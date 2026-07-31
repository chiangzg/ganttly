/**
 * Right-side edit drawer (PRD §3.10) — transactional draft semantics
 * (editor-interaction-optimization-plan §2.2).
 *
 * The drawer keeps a COMPLETE draft of the task (base fields + assignments +
 * dependencies + constraints). Editing only mutates the local draft — it
 * NEVER dispatches mid-edit. The store is touched exactly once, on explicit
 * "Save", via a single composite command (`updateTaskFromDraftCommand`) so
 * one save == one undo record and one undo restores the full pre-save state
 * (including rollup + dependency cascade).
 *
 * - Cancel / ✕ / Escape: discard the draft and close.
 * - Dirty guard: if the draft has changes, closing prompts "discard?".
 * - Save is disabled when the draft is clean or fails validation.
 *
 * Note: this component deliberately does NOT live-update the Canvas while
 * editing (e.g. moving a task bar by typing a new start). That was the old
 * behaviour and is exactly what broke cancel/undo. Preview-on-edit is out of
 * scope for this PR; the plan tracks it under the docked-inspector PR (§3.7).
 */
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore, updateTaskFromDraftCommand } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import type {
  Task,
  Dependency,
  DependencyType,
  Resource,
  ConstraintType,
  TaskAssignment,
  TaskConstraints,
  BaselineTask,
} from '@ganttly/schema';
import {
  resolveCalendar,
  endDateFromDuration,
  durationBetween,
  isNonWorkingDay,
} from '@/lib/calendar';
import { wouldCreateCycle } from '@/lib/schedule';
import { computeTaskPersonDays } from '@/lib/cost';
import { computeAllRollups } from '@/lib/summary';
import { snapConstraintDate } from '@/lib/schedule';
import {
  findActiveBaseline,
  buildEffectiveValues,
  compareTaskToBaseline,
  type TaskBaselineVariance,
} from '@/lib/baseline';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { DeleteTaskConfirm } from './DeleteTaskConfirm';

export function TaskDrawer() {
  const { t } = useTranslation();
  const drawer = useViewStore((s) => s.drawer);
  const closeDrawer = useViewStore((s) => s.closeDrawer);
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const activeBaselineId = useViewStore((s) => s.activeBaselineId);
  const selectedId = file.viewState.selectedTaskId;
  const selectedTask = file.tasks.find((x) => x.id === selectedId) ?? null;
  const cal = useMemo(() => resolveCalendar(file.calendar), [file.calendar]);

  // ---- Transactional draft (plan §2.2) ----
  // `before` is the snapshot captured when the drawer opened (or when the
  // selected task changed). `draft` is the working copy the user edits. They
  // diverge as the user types; Save turns (before → draft) into one command.
  const [before, setBefore] = useState<Task | null>(null);
  const [draft, setDraft] = useState<Task | null>(null);
  const [overtimeDate, setOvertimeDate] = useState('');
  const [overtimeError, setOvertimeError] = useState('');
  // Dirty-guard confirm dialog state.
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const beforeRef = useRef(before);
  const draftRef = useRef(draft);
  const restoredSelectionRef = useRef<string | null>(null);
  beforeRef.current = before;
  draftRef.current = draft;

  const resetDraft = useCallback((nextTask: Task | null) => {
    const normalised = normalizeDraftTask(nextTask);
    const nextDraft = normalised ? { ...normalised } : null;
    beforeRef.current = normalised;
    draftRef.current = nextDraft;
    setBefore(normalised);
    setDraft(nextDraft);
    setOvertimeDate('');
    setOvertimeError('');
    setDiscardOpen(false);
  }, []);

  // (Re)initialise the draft when the selected task changes or the drawer
  // opens. We snapshot `task` as `before` so Save can diff against the true
  // pre-edit state even if autosave rewrites `file.tasks` underneath us.
  useEffect(() => {
    if (drawer === 'closed') return;

    // A rejected task switch restores selection to the task being edited. Do
    // not interpret that restoration as another switch or reset the draft.
    if (restoredSelectionRef.current === selectedId) {
      restoredSelectionRef.current = null;
      return;
    }

    const currentBefore = beforeRef.current;
    const currentDraft = draftRef.current;
    if (
      currentBefore &&
      currentDraft &&
      selectedId &&
      selectedId !== currentBefore.id &&
      !tasksEqual(currentBefore, currentDraft)
    ) {
      setPendingTaskId(selectedId);
      restoredSelectionRef.current = currentBefore.id;
      const currentFile = useProjectStore.getState().file;
      useProjectStore.setState({
        file: {
          ...currentFile,
          viewState: { ...currentFile.viewState, selectedTaskId: currentBefore.id },
        },
      });
      return;
    }

    const nextTask = useProjectStore
      .getState()
      .file.tasks.find((candidate) => candidate.id === selectedId);
    resetDraft(nextTask ?? null);
    // Depend on task id rather than object identity: same-task store updates
    // must not overwrite an in-progress draft.
  }, [drawer, resetDraft, selectedId]);

  // Keep rendering calculations bound to the task whose draft is open while a
  // different selection is waiting for discard confirmation.
  const task = before
    ? (file.tasks.find((candidate) => candidate.id === before.id) ?? selectedTask)
    : selectedTask;

  // Baseline variance for the selected task (baseline-comparison spec §5.7).
  const activeBaseline = findActiveBaseline(file.baselines, activeBaselineId);
  const baselineVariance = useMemo(() => {
    if (!task || !activeBaseline) return null;
    const effective = buildEffectiveValues(file, cal);
    const eff = effective.get(task.id);
    if (!eff) return null;
    const byId = new Map(activeBaseline.tasks.map((bt) => [bt.id, bt]));
    return compareTaskToBaseline(eff, byId.get(task.id), cal);
  }, [task, activeBaseline, file, cal]);

  // ---- Validation (plan §2.2 step 3) ----
  const errors = useMemo(
    () => validateDraft(draft, before, file.tasks, file.resources),
    [draft, before, file.tasks, file.resources],
  );
  const isValid = Object.keys(errors).length === 0;

  // Dirty = draft differs from `before` by any commit-relevant field.
  const isDirty = useMemo(
    () => before !== null && draft !== null && !tasksEqual(before, draft),
    [before, draft],
  );

  // ---- Draft mutation helpers (NEVER dispatch) ----
  const patchDraft = useCallback((patch: Partial<Task>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }, []);

  const close = useCallback(() => {
    // Dirty guard: prompt before discarding an uncommitted draft.
    if (isDirty) {
      setDiscardOpen(true);
      return;
    }
    closeDrawer();
  }, [isDirty, closeDrawer]);

  const save = useCallback(() => {
    if (!before || !draft || !isValid || !isDirty) return;
    dispatch(updateTaskFromDraftCommand(before, draft));
    // After commit, re-snapshot so a subsequent no-op edit isn't seen as dirty.
    setBefore(draft);
    closeDrawer();
  }, [before, draft, isValid, isDirty, dispatch, closeDrawer]);

  // Escape closes (with dirty guard). Bound on the aside so it works regardless
  // of which input has focus, and only when the drawer is open.
  useEffect(() => {
    if (drawer === 'closed') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (discardOpen || deleteConfirmOpen || pendingTaskId) return;
        // Don't hijack Escape from an open <select> dropdown etc. — let those
        // close first. Radix dialogs stop propagation, so this only fires for
        // plain inputs.
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, deleteConfirmOpen, discardOpen, drawer, pendingTaskId]);

  if (drawer === 'closed' || !draft || !task || !before) return null;

  const deleteTask = () => {
    setDeleteConfirmOpen(true);
  };

  // G13/Q13: summary tasks roll up their children; assigning resources to a
  // summary would double-count person-days. Block it at the UI layer (the cost
  // lib also short-circuits, so this is defense-in-depth).
  const hasChildren = file.tasks.some((x) => x.parentId === task.id);

  // Person-days for this task: summary → rolled-up children sum; leaf → own.
  // Computed from the DRAFT so the user sees the effect of assignment /
  // overtime / date edits immediately, without committing (plan §2.2: the
  // draft is the local source of truth during editing). For summary tasks the
  // draft's own dates/assignments are not authoritative (children roll up), so
  // we read the live rollup there.
  const personDays = hasChildren
    ? (computeAllRollups(file.tasks, file.resources, cal).get(task.id)?.personDays ?? 0)
    : computeTaskPersonDays(draft, file.resources, cal);

  // ---- Draft-aware field handlers ----
  const onNameChange = (v: string) => patchDraft({ name: v });

  const onStartChange = (start: string) => {
    const end = endDateFromDuration(start, draft.duration || 1, cal);
    const overtimeDates = (draft.overtimeDates ?? []).filter((d) => d >= start && d <= end);
    patchDraft({
      start,
      end,
      duration: durationBetween(start, end, cal),
      overtimeDates,
    });
  };

  const onEndChange = (end: string) => {
    const duration = durationBetween(draft.start, end, cal);
    const overtimeDates = (draft.overtimeDates ?? []).filter((d) => d >= draft.start && d <= end);
    patchDraft({ end, duration: Math.max(0, duration), overtimeDates });
  };

  const onDurationChange = (raw: number) => {
    const duration = Math.max(0, raw || 0);
    const end = endDateFromDuration(draft.start, duration, cal);
    const overtimeDates = (draft.overtimeDates ?? []).filter((d) => d >= draft.start && d <= end);
    patchDraft({ duration, end, overtimeDates });
  };

  const onProgressChange = (progress: number) => patchDraft({ progress });

  const onMilestoneChange = (isMilestone: boolean) => {
    const patch: Partial<Task> = { isMilestone };
    if (isMilestone) {
      patch.duration = 0;
      patch.end = draft.start;
      patch.progress = draft.progress === 0 ? 100 : draft.progress;
      patch.overtimeDates = [];
    }
    patchDraft(patch);
  };

  const addOvertimeDate = () => {
    if (!overtimeDate) {
      setOvertimeError(t('drawer.overtimeDateRequired'));
      return;
    }
    if (overtimeDate < draft.start || overtimeDate > draft.end) {
      setOvertimeError(t('drawer.overtimeDateOutOfRange'));
      return;
    }
    if (!isNonWorkingDay(overtimeDate, cal)) {
      setOvertimeError(t('drawer.overtimeDateMustBeRestDay'));
      return;
    }
    if ((draft.overtimeDates ?? []).includes(overtimeDate)) {
      setOvertimeError(t('drawer.overtimeDateDuplicate'));
      return;
    }
    patchDraft({
      overtimeDates: [...(draft.overtimeDates ?? []), overtimeDate].sort(),
    });
    setOvertimeDate('');
    setOvertimeError('');
  };

  const removeOvertimeDate = (date: string) => {
    patchDraft({
      overtimeDates: (draft.overtimeDates ?? []).filter((item) => item !== date),
    });
    setOvertimeError('');
  };

  // ---- Dependency draft edits ----
  const addDependency = (dep: Dependency) => {
    if (
      wouldCreateCycle(file.tasks, {
        successorId: task.id,
        predecessorId: dep.targetId,
      })
    ) {
      window.alert(t('errors.cycleDetected'));
      return;
    }
    patchDraft({
      dependencies: [...draft.dependencies.filter((d) => d.targetId !== dep.targetId), dep],
    });
  };

  const removeDependency = (targetId: string) => {
    patchDraft({
      dependencies: draft.dependencies.filter((d) => d.targetId !== targetId),
    });
  };

  // ---- Assignment draft edits ----
  const assignResource = (assignment: TaskAssignment) => {
    patchDraft({
      assignments: [
        ...draft.assignments.filter((a) => a.resourceId !== assignment.resourceId),
        assignment,
      ],
    });
  };

  const unassignResource = (resourceId: string) => {
    patchDraft({
      assignments: draft.assignments.filter((a) => a.resourceId !== resourceId),
    });
  };

  // ---- Constraint draft edits ----
  const updateConstraint = (constraint: TaskConstraints) => {
    patchDraft({ constraints: constraint });
  };

  const saveDisabledReason = !isDirty
    ? t('drawer.saveDisabledNoChange')
    : !isValid
      ? t('drawer.saveDisabledInvalid')
      : null;

  return (
    <>
      <aside className="absolute right-0 top-0 z-10 flex h-full w-80 flex-col border-l border-border bg-bg-elevated shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold">{t('drawer.title')}</h2>
          <button
            onClick={close}
            className="text-fg-muted hover:text-fg"
            aria-label={t('drawer.close')}
          >
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
          <Field label={t('drawer.name')} error={errors.name}>
            <input
              className="input"
              value={draft.name}
              onChange={(e) => onNameChange(e.target.value)}
            />
          </Field>
          <Field label={t('drawer.start')} error={errors.start}>
            <input
              type="date"
              className="input"
              value={draft.start}
              onChange={(e) => onStartChange(e.target.value)}
            />
          </Field>
          <Field label={t('drawer.end')} error={errors.end}>
            <input
              type="date"
              className="input"
              value={draft.end}
              onChange={(e) => onEndChange(e.target.value)}
            />
          </Field>
          <Field label={t('drawer.duration')} error={errors.duration}>
            <input
              type="number"
              min={0}
              className="input"
              value={draft.duration}
              onChange={(e) => onDurationChange(Number(e.target.value))}
            />
          </Field>
          {activeBaseline && baselineVariance ? (
            <BaselineVarianceBlock
              name={activeBaseline.name}
              variance={baselineVariance}
              baselineTask={activeBaseline.tasks.find((bt) => bt.id === task.id) ?? null}
            />
          ) : null}
          <Field label={t('drawer.progress')}>
            <input
              type="range"
              min={0}
              max={100}
              value={draft.progress}
              onChange={(e) => onProgressChange(Number(e.target.value))}
            />
            <span className="ml-2 tabular-nums">{draft.progress}%</span>
          </Field>
          <Field label={t('drawer.milestone')}>
            <input
              type="checkbox"
              checked={draft.isMilestone}
              onChange={(e) => onMilestoneChange(e.target.checked)}
            />
          </Field>
          <Field label={t('drawer.overtimeDates')}>
            {hasChildren || draft.isMilestone ? (
              <p className="text-xs text-fg-muted">
                {hasChildren ? t('drawer.summaryNoOvertime') : t('drawer.milestoneNoOvertime')}
              </p>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="date"
                    className="input min-w-0 flex-1"
                    min={draft.start}
                    max={draft.end}
                    value={overtimeDate}
                    onChange={(e) => {
                      setOvertimeDate(e.target.value);
                      setOvertimeError('');
                    }}
                  />
                  <button
                    type="button"
                    className="rounded border border-border px-2 text-xs hover:bg-bg"
                    onClick={addOvertimeDate}
                  >
                    {t('drawer.addOvertimeDate')}
                  </button>
                </div>
                {overtimeError && <p className="text-xs text-danger">{overtimeError}</p>}
                {(draft.overtimeDates ?? []).length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {[...(draft.overtimeDates ?? [])].sort().map((date) => (
                      <span
                        key={date}
                        className="inline-flex items-center gap-1 rounded bg-warning/15 px-2 py-1 text-xs text-warning"
                      >
                        {date}
                        <button
                          type="button"
                          aria-label={t('drawer.removeOvertimeDate', { date })}
                          onClick={() => removeOvertimeDate(date)}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-fg-muted">{t('drawer.noOvertimeDates')}</p>
                )}
              </div>
            )}
          </Field>
          <Field label={t('drawer.color')}>
            <input
              type="color"
              value={draft.color ?? '#60a5fa'}
              onChange={(e) => patchDraft({ color: e.target.value })}
            />
          </Field>
          <Field label={t('drawer.note')}>
            <textarea
              className="input min-h-24"
              value={draft.note ?? ''}
              onChange={(e) => patchDraft({ note: e.target.value })}
            />
          </Field>
          <Field label={t('drawer.dependencies')} error={errors.dependencies}>
            <div className="space-y-2">
              {draft.dependencies.map((dep) => {
                const pred = file.tasks.find((x) => x.id === dep.targetId);
                return (
                  <div key={dep.targetId} className="flex items-center gap-2">
                    <span className="flex-1 truncate text-xs">{pred?.name ?? dep.targetId}</span>
                    <span className="text-xs text-fg-muted">
                      {t(`drawer.depType${dep.type}` as `drawer.depType${string}`)}
                    </span>
                    <span className="text-xs text-fg-muted">lag={dep.lag}</span>
                    <button
                      onClick={() => removeDependency(dep.targetId)}
                      className="text-danger hover:underline"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              <DependencyAdder
                existingTargetIds={draft.dependencies.map((d) => d.targetId)}
                candidates={file.tasks.filter((x) => x.id !== task.id)}
                onAdd={(targetId, type, lag) => addDependency({ targetId, type, lag })}
              />
            </div>
          </Field>
          <Field label={t('drawer.assignments')} error={errors.assignments}>
            <div className="mb-1 text-xs text-fg-muted">
              {t('drawer.totalPersonDays')}:{' '}
              <span className="font-medium text-fg">{personDays}</span>
            </div>
            {hasChildren ? (
              <p className="text-xs text-fg-muted">{t('drawer.summaryNoAssignment')}</p>
            ) : (
              <div className="space-y-2">
                {draft.assignments.map((a) => {
                  const resource = file.resources.find((r) => r.id === a.resourceId);
                  return (
                    <div key={a.resourceId} className="flex items-center gap-2">
                      <span className="flex-1 truncate text-xs">
                        {resource?.name ?? a.resourceId}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={a.load}
                        className="flex-1"
                        onChange={(e) =>
                          assignResource({ resourceId: a.resourceId, load: Number(e.target.value) })
                        }
                      />
                      <span className="w-8 text-right text-xs text-fg-muted">{a.load}%</span>
                      <button
                        onClick={() => unassignResource(a.resourceId)}
                        className="text-danger hover:underline"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                {file.resources.length > 0 && (
                  <AssignmentAdder
                    existingResourceIds={draft.assignments.map((a) => a.resourceId)}
                    resources={file.resources}
                    onAssign={(resourceId, load) => assignResource({ resourceId, load })}
                  />
                )}
              </div>
            )}
          </Field>
          <Field label={t('drawer.constraint')} error={errors.constraints}>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <select
                  className="input flex-1"
                  value={draft.constraints.type}
                  onChange={(e) => {
                    const type = e.target.value as ConstraintType;
                    updateConstraint({
                      type,
                      date: type === 'none' ? undefined : (draft.constraints.date ?? draft.start),
                    });
                  }}
                >
                  <option value="none">{t('drawer.constraintNone')}</option>
                  <option value="startNoEarlierThan">{t('drawer.constraintSNET')}</option>
                  <option value="mustStartOn">{t('drawer.constraintMSO')}</option>
                  <option value="mustFinishOn">{t('drawer.constraintMFO')}</option>
                  <option value="finishNoLaterThan">{t('drawer.constraintFNLT')}</option>
                </select>
                {draft.constraints.type !== 'none' && (
                  <input
                    type="date"
                    className="input w-36"
                    value={draft.constraints.date ?? draft.start}
                    onChange={(e) =>
                      updateConstraint({ type: draft.constraints.type, date: e.target.value })
                    }
                  />
                )}
              </div>
              {/* G12/Q11 snap feedback: computed from the DRAFT constraint date
                  so the user sees the effect before committing. */}
              {draft.constraints.type !== 'none' &&
                draft.constraints.date &&
                (() => {
                  const snap = snapConstraintDate(draft.constraints.date, cal);
                  return snap.snapped ? (
                    <p className="text-xs text-fg-muted">
                      {t('drawer.constraintSnapped', { from: snap.original, to: snap.date })}
                    </p>
                  ) : null;
                })()}
            </div>
          </Field>
        </div>
        <div className="flex gap-2 border-t border-border p-3">
          <button onClick={deleteTask} className="btn-danger flex-1">
            {t('drawer.delete')}
          </button>
          <button onClick={close} className="btn flex-1">
            {t('drawer.cancel')}
          </button>
          <button
            onClick={save}
            disabled={!isDirty || !isValid}
            title={saveDisabledReason ?? undefined}
            className="btn-primary flex-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('drawer.save')}
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
        .btn-primary {
          padding: 6px 12px;
          background: rgb(var(--color-primary));
          border: 1px solid rgb(var(--color-primary));
          border-radius: 4px;
          color: white;
          font-size: 13px;
          cursor: pointer;
        }
        .btn-primary:hover { filter: brightness(0.95); }
      `}</style>
      </aside>

      {/* Dirty-guard: closing with uncommitted changes prompts discard/keep. */}
      <ConfirmDialog
        open={discardOpen}
        title={t('drawer.unsavedChanges')}
        description={t('drawer.unsavedChanges')}
        confirmLabel={t('drawer.discard')}
        cancelLabel={t('drawer.keepEditing')}
        danger
        onOpenChange={setDiscardOpen}
        onConfirm={() => {
          closeDrawer();
        }}
      />
      <ConfirmDialog
        open={pendingTaskId !== null}
        title={t('drawer.unsavedChanges')}
        description={t('drawer.switchTaskUnsaved')}
        confirmLabel={t('drawer.discardAndSwitch')}
        cancelLabel={t('drawer.keepEditing')}
        danger
        onOpenChange={(open) => {
          if (!open) setPendingTaskId(null);
        }}
        onConfirm={() => {
          if (!pendingTaskId) return;
          const nextTask = useProjectStore
            .getState()
            .file.tasks.find((candidate) => candidate.id === pendingTaskId);
          if (!nextTask) {
            setPendingTaskId(null);
            return;
          }
          resetDraft(nextTask);
          setPendingTaskId(null);
          const currentFile = useProjectStore.getState().file;
          useProjectStore.setState({
            file: {
              ...currentFile,
              viewState: { ...currentFile.viewState, selectedTaskId: nextTask.id },
            },
          });
        }}
      />
      {deleteConfirmOpen && task && (
        <DeleteTaskConfirm
          taskId={task.id}
          onClose={() => {
            setDeleteConfirmOpen(false);
            closeDrawer();
          }}
        />
      )}
    </>
  );
}

function normalizeDraftTask(task: Task | null): Task | null {
  if (!task) return null;
  return {
    ...task,
    overtimeDates: task.overtimeDates ?? [],
    constraints: { ...task.constraints, type: task.constraints.type ?? 'none' },
  };
}

/**
 * Validate the draft against the project. Returns a map of field → error
 * message (empty when valid). The Save button is disabled while any entry
 * exists (plan §2.2 step 3).
 *
 * `before` is passed so dependency-cycle checks use the pre-edit graph plus
 * the draft's new edges (not the live file, which hasn't been committed).
 */
function validateDraft(
  draft: Task | null,
  before: Task | null,
  liveTasks: ReadonlyArray<Task>,
  resources: ReadonlyArray<Resource>,
): Partial<Record<keyof Task, string>> {
  const errors: Partial<Record<keyof Task, string>> = {};
  if (!draft || !before) return errors;

  if (!draft.name || draft.name.trim() === '') {
    errors.name = 'drawer.errorNameRequired';
  }
  if (draft.duration < 0) {
    errors.duration = 'drawer.errorDurationNegative';
  }
  // End-before-start: only meaningful for non-milestone tasks (milestones
  // force end == start). Compare as dates so partial input doesn't false-fire.
  if (!draft.isMilestone && draft.end < draft.start) {
    errors.end = 'drawer.errorEndBeforeStart';
  }

  // Constraint with a dated type must carry a date. Treat a missing/undefined
  // `type` (legacy `constraints: {}` files) as 'none' so old fixtures don't
  // false-fire — the normalizer backfills `{type:'none'}` on load, but the
  // drawer reads the raw task and tests inject legacy shapes.
  const constraintType = draft.constraints.type ?? 'none';
  if (constraintType !== 'none' && !draft.constraints.date) {
    errors.constraints = 'drawer.errorConstraintDateRequired';
  }

  // Dependency cycle check: simulate the draft's edges on the live graph.
  if (draft.dependencies.length > 0) {
    const cycleDep = draft.dependencies.find((d) =>
      wouldCreateCycle(liveTasks, { successorId: draft.id, predecessorId: d.targetId }),
    );
    if (cycleDep) {
      errors.dependencies = 'drawer.errorCycleDetected';
    }
  }

  // Resource existence: an assignment whose resource was deleted is invalid.
  if (draft.assignments.some((a) => !resources.some((r) => r.id === a.resourceId))) {
    errors.assignments = 'drawer.errorResourceMissing';
  }

  return errors;
}

/**
 * Structural equality over commit-relevant fields. Mirrors the command's own
 * `tasksEqualForCommit` so the dirty flag agrees with whether Save will no-op.
 */
function tasksEqual(a: Task, b: Task): boolean {
  const keys: Array<keyof Task> = [
    'name',
    'start',
    'end',
    'duration',
    'progress',
    'isMilestone',
    'color',
    'note',
    'overtimeDates',
    'dependencies',
    'constraints',
    'assignments',
  ];
  for (const k of keys) {
    const av = (a as unknown as Record<string, unknown>)[k as string];
    const bv = (b as unknown as Record<string, unknown>)[k as string];
    if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
  }
  return true;
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : null}
    </label>
  );
}

const MINUS_SIGN = '\u2212';

/**
 * Read-only baseline variance block (baseline-comparison spec §5.7).
 *
 * Shown beneath the date/duration editors when a baseline is active. Three
 * columns (start / finish / duration deltas) + the baseline date range. Delay
 * values use danger, early values success, zero muted. No editing affordance
 * — baseline management stays in its own dialogs.
 */
function BaselineVarianceBlock({
  name,
  variance,
  baselineTask,
}: {
  name: string;
  variance: TaskBaselineVariance;
  baselineTask: BaselineTask | null;
}) {
  const { t } = useTranslation();

  if (variance.status === 'added') {
    return (
      <div className="rounded-lg border border-border bg-bg p-3 text-xs text-fg-muted">
        <div className="mb-1 font-medium text-fg">{t('baseline.drawerTitle', { name })}</div>
        <p>{t('baseline.drawerAdded')}</p>
      </div>
    );
  }

  const fmt = (n: number) => {
    if (n > 0) return { text: `+${n}`, tone: 'text-danger' };
    if (n < 0) return { text: `${MINUS_SIGN}${Math.abs(n)}`, tone: 'text-success' };
    return { text: '0', tone: 'text-fg-muted' };
  };
  const start = fmt(variance.startDelta);
  const finish = fmt(variance.finishDelta);
  const duration = fmt(variance.durationDelta);

  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <div className="mb-2 text-xs font-medium text-fg">{t('baseline.drawerTitle', { name })}</div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[11px] text-fg-muted">{t('baseline.varianceStart')}</div>
          <div className={`mt-0.5 text-sm font-medium tabular-nums ${start.tone}`}>
            {start.text}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-fg-muted">{t('baseline.varianceFinish')}</div>
          <div className={`mt-0.5 text-sm font-medium tabular-nums ${finish.tone}`}>
            {finish.text}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-fg-muted">{t('baseline.varianceDuration')}</div>
          <div className={`mt-0.5 text-sm font-medium tabular-nums ${duration.tone}`}>
            {duration.text}
          </div>
        </div>
      </div>
      {baselineTask ? (
        <div className="mt-2 text-[11px] text-fg-muted">
          {t('baseline.drawerBaselineRange', {
            start: baselineTask.start,
            end: baselineTask.end,
          })}
        </div>
      ) : null}
    </div>
  );
}

function DependencyAdder({
  existingTargetIds,
  candidates,
  onAdd,
}: {
  existingTargetIds: string[];
  candidates: Task[];
  onAdd: (targetId: string, type: DependencyType, lag: number) => void;
}) {
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState('');
  const [type, setType] = useState<DependencyType>('FS');
  const [lag, setLag] = useState(0);

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
        <option value="FS">{t('drawer.depTypeFS')}</option>
        <option value="SS">{t('drawer.depTypeSS')}</option>
        <option value="FF">{t('drawer.depTypeFF')}</option>
        <option value="SF">{t('drawer.depTypeSF')}</option>
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

function AssignmentAdder({
  existingResourceIds,
  resources,
  onAssign,
}: {
  existingResourceIds: string[];
  resources: Resource[];
  onAssign: (resourceId: string, load: number) => void;
}) {
  const { t } = useTranslation();
  const [resourceId, setResourceId] = useState('');
  const [load, setLoad] = useState(50);

  const available = resources.filter((r) => !existingResourceIds.includes(r.id));

  return (
    <div className="flex items-center gap-2 text-xs">
      <select
        className="input flex-1"
        value={resourceId}
        onChange={(e) => setResourceId(e.target.value)}
      >
        <option value="">{t('drawer.addAssignment')}</option>
        {available.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name || r.id}
          </option>
        ))}
      </select>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={load}
        onChange={(e) => setLoad(Number(e.target.value))}
      />
      <span className="w-8 text-right text-fg-muted">{load}%</span>
      <button
        className="btn px-2"
        disabled={!resourceId}
        onClick={() => {
          if (!resourceId) return;
          onAssign(resourceId, load);
          setResourceId('');
        }}
      >
        +
      </button>
    </div>
  );
}
