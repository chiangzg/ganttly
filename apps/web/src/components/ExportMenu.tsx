/**
 * Export menu — JSON (round-trip with `.ganttly.json`) and CSV (task table).
 * (PRD §3.9, M4.1-M4.2)
 */
import { useTranslation } from 'react-i18next';
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
    const rows: string[] = ['WBS,Name,Start,End,Duration,Progress,Milestone,Color'];
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
        ].join(','),
      );
    }
    const blob = new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    download(blob, `${file.project.name || 'ganttly'}.csv`);
  };

  return (
    <>
      <ToolbarButton onClick={exportJson} title={t('toolbar.exportJson')}>
        {t('toolbar.exportJson')}
      </ToolbarButton>
      <ToolbarButton onClick={exportCsv} title={t('toolbar.exportCsv')}>
        {t('toolbar.exportCsv')}
      </ToolbarButton>
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
