/**
 * BaselineControl — toolbar entry + radio dropdown menu + comparison summary
 * (baseline-comparison spec §5.2, §5.3, §6.3).
 *
 * Responsibilities:
 * - Render the toolbar trigger button (state-dependent label, spec §5.2).
 * - Open a Radix DropdownMenu with: current summary, a radio list of baselines
 *   (first item = "不比较"), and actions to create / manage.
 * - Keep `useViewStore.activeBaselineId` in sync with reality: a useEffect
 *   watches `file.baselines` and clears a stale id (spec §6.3 — covers
 *   undo-create, delete, import replacement, project switch).
 *
 * Selecting a baseline does NOT mutate project data and does NOT enter the
 * undo stack — it only sets the ephemeral `activeBaselineId` (spec §4.2).
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useMemo, useState } from 'react';
import { Layers3, Check, Plus, Settings2 } from 'lucide-react';
import { useProjectStore } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { findActiveBaseline, summarizeBaselineVariance } from '@/lib/baseline';
import { resolveCalendar } from '@/lib/calendar';
import { ToolbarButton } from './ui/ToolbarButton';
import { useBaselineSelection } from './useBaselineSelection';
import {
  CreateBaselineDialog,
  ManageBaselinesDialog,
  RenameBaselineDialog,
  DeleteBaselineDialog,
} from './BaselineDialogs';
import type { Baseline } from '@ganttly/schema';

/** Max display width for the active baseline name before ellipsis (spec §5.2). */
const NAME_MAX_WIDTH = 120;

export function BaselineControl() {
  const file = useProjectStore((s) => s.file);
  const activeBaselineId = useViewStore((s) => s.activeBaselineId);
  const setActiveBaselineId = useViewStore((s) => s.setActiveBaselineId);
  const switchBaseline = useBaselineSelection();

  const [createOpen, setCreateOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [renaming, setRenaming] = useState<Baseline | null>(null);
  const [deleting, setDeleting] = useState<Baseline | null>(null);

  // Stale-id cleanup (spec §6.3): if the active baseline disappears (undo of
  // create, delete, import replace, project switch), clear it silently. This
  // covers all "active id no longer exists" cases without per-command hooks.
  useEffect(() => {
    if (!activeBaselineId) return;
    const exists = file.baselines.some((b) => b.id === activeBaselineId);
    if (!exists) setActiveBaselineId(null);
  }, [file.baselines, activeBaselineId, setActiveBaselineId]);

  const active = findActiveBaseline(file.baselines, activeBaselineId);
  const hasBaselines = file.baselines.length > 0;
  const hasTasks = file.tasks.length > 0;

  // Button label + pressed state (spec §5.2 table).
  let label: string;
  let pressed = false;
  if (!hasBaselines) {
    label = '创建基线';
  } else if (active) {
    label = `基线：${active.name}`;
    pressed = true;
  } else {
    label = '基线';
  }

  // Newest-first for the menu (spec §2.1).
  const sortedBaselines = [...file.baselines].sort((a, b) =>
    a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
  );

  // Comparison summary for the menu header (spec §5.3).
  const summary = useMemo(() => {
    if (!active) return null;
    return summarizeBaselineVariance(file, active, resolveCalendar(file.calendar));
  }, [active, file.tasks, file.resources, file.calendar]);
  const summaryText = summary
    ? summary.lateLeafCount > 0
      ? `${summary.lateLeafCount} 项延期 · 最大 +${summary.maxFinishDelay} 工作日`
      : '无完成延期'
    : null;
  const structureSummaryText = summary
    ? [
        summary.addedLeafCount > 0 ? `新增 ${summary.addedLeafCount} 项` : null,
        summary.deletedTaskCount > 0 ? `原任务已删除 ${summary.deletedTaskCount} 项` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  // The trigger is disabled only when there are no tasks (spec §4.1: empty
  // projects can't create baselines). With baselines present, it opens the menu.
  const triggerDisabled = !hasTasks && !hasBaselines;
  const triggerTitle = triggerDisabled ? '至少添加一个任务后才能创建基线' : label;

  const openCreate = () => setCreateOpen(true);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <ToolbarButton pressed={pressed} disabled={triggerDisabled} title={triggerTitle}>
            <span className="flex items-center gap-1.5">
              <Layers3 size={15} />
              <span
                className="max-w-[var(--baseline-name-max)] truncate"
                style={{ ['--baseline-name-max' as string]: `${NAME_MAX_WIDTH}px` }}
              >
                {label}
              </span>
            </span>
          </ToolbarButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            className="z-40 w-[280px] rounded-xl border border-border bg-bg-elevated p-2 shadow-xl"
          >
            <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              基线对比
            </div>

            {active && summaryText ? (
              <div className="px-2 pb-2 text-xs text-fg-muted">{summaryText}</div>
            ) : null}
            {active && structureSummaryText ? (
              <div className="px-2 pb-2 text-xs text-fg-muted">{structureSummaryText}</div>
            ) : null}

            <DropdownMenu.RadioGroup
              value={activeBaselineId ?? '__none__'}
              onValueChange={(v) => switchBaseline(v === '__none__' ? null : v)}
            >
              <DropdownMenu.RadioItem
                value="__none__"
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-fg outline-none data-[highlighted]:bg-bg"
              >
                <RadioIndicator />
                不比较
              </DropdownMenu.RadioItem>
              {sortedBaselines.map((b) => (
                <DropdownMenu.RadioItem
                  key={b.id}
                  value={b.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-fg outline-none data-[highlighted]:bg-bg"
                >
                  <RadioIndicator />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate" title={b.name}>
                      {b.name}
                    </span>
                    <span className="text-[11px] text-fg-muted">
                      {b.capturedAt.slice(0, 10)} · {b.tasks.length} 任务
                    </span>
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>

            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item
              onSelect={() => openCreate()}
              disabled={!hasTasks}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-fg outline-none data-[highlighted]:bg-bg data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40"
            >
              <Plus size={15} />
              保存当前计划为基线…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => setManageOpen(true)}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-fg outline-none data-[highlighted]:bg-bg"
            >
              <Settings2 size={15} />
              管理基线…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <CreateBaselineDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ManageBaselinesDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        onCreate={openCreate}
        onRename={(b) => setRenaming(b)}
        onDelete={(b) => setDeleting(b)}
        onSelectBaseline={switchBaseline}
      />
      <RenameBaselineDialog baseline={renaming} onOpenChange={(o) => !o && setRenaming(null)} />
      <DeleteBaselineDialog
        baseline={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onSelectBaseline={switchBaseline}
      />
    </>
  );
}

/** Shared radio indicator: shows a check only on the selected item. */
function RadioIndicator() {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      <DropdownMenu.ItemIndicator>
        <Check size={14} className="text-primary" />
      </DropdownMenu.ItemIndicator>
    </span>
  );
}
