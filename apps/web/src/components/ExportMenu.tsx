/**
 * Export menu — JSON (round-trip with `.ganttly.json`) and CSV (task table).
 * (PRD §3.9, M4.1-M4.2)
 *
 * These items render inside a Radix DropdownMenu.Content. We wrap them as
 * DropdownMenu.Item (asChild) so they pick up keyboard navigation and roles.
 * onSelect keeps the menu mounted across the synchronous download trigger.
 */
import { useTranslation } from 'react-i18next';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useProjectStore } from '@/store/useProjectStore';
import { ToolbarButton } from './ui/ToolbarButton';
import { buildTree, flattenVisible } from '@/engine/scene';

export function ExportMenu() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    download(blob, `${file.project.name || 'ganttly'}.ganttly.json`);
  };

  const exportCsv = () => {
    const tree = buildTree(file.tasks);
    const flat = flattenVisible(tree, new Set(file.viewState.collapsedTaskIds));
    const rows: string[] = ['WBS,Name,Start,End,Duration,Progress,Milestone,Color,OvertimeDates'];
    for (const node of flat) {
      const t = node.task;
      rows.push(
        [
          csv(node.wbsNumber),
          csv(t.name),
          t.start,
          t.end,
          t.duration,
          t.progress,
          t.isMilestone ? '1' : '0',
          t.color ?? '',
          csv([...(t.overtimeDates ?? [])].sort().join(';')),
        ].join(','),
      );
    }
    const blob = new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    download(blob, `${file.project.name || 'ganttly'}.csv`);
  };

  const onSelectJson = (e: Event) => {
    e.preventDefault();
    exportJson();
  };
  const onSelectCsv = (e: Event) => {
    e.preventDefault();
    exportCsv();
  };

  return (
    <>
      <DropdownMenu.Item asChild onSelect={onSelectJson} className="outline-none">
        <ToolbarButton title={t('toolbar.exportJson')}>{t('toolbar.exportJson')}</ToolbarButton>
      </DropdownMenu.Item>
      <DropdownMenu.Item asChild onSelect={onSelectCsv} className="outline-none">
        <ToolbarButton title={t('toolbar.exportCsv')}>{t('toolbar.exportCsv')}</ToolbarButton>
      </DropdownMenu.Item>
    </>
  );
}

function csv(value: string): string {
  // Escape double-quotes and wrap if contains comma/quote/newline.
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
