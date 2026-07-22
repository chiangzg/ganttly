/**
 * Import menu — wires JSON import and `.gan` (GanttProject) import (PRD §3.9).
 *
 * Triggers a hidden <input type=file>, reads the file, dispatches to either
 * `validateGanttlyFile` (for `.ganttly.json`) or `parseGan` (for `.gan`),
 * then sets the loaded file into the store. Errors surface via `window.alert`
 * for MVP — P1 can replace with a toast.
 */
import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import { ToolbarButton } from './ui/ToolbarButton';
import { useProjectStore } from '@/store/useProjectStore';
import { validateGanttlyFile, formatAjvErrors, normalizeFile } from '@ganttly/schema';
import { parseGan, GanImportError } from '@ganttly/gan-parser';
import { getCalendar } from '@ganttly/calendar-data';
import type { Holiday } from '@ganttly/schema';
import type { GanttlyFile } from '@ganttly/schema';

/** Holiday provider injected into normalizeFile (keeps schema pkg dependency-free). */
const getHolidays = (region: string): Holiday[] => getCalendar(region).holidays;

export function ImportMenu() {
  const { t } = useTranslation();
  const setFile = useProjectStore((s) => s.setFile);
  const save = useProjectStore((s) => s.save);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const ganInputRef = useRef<HTMLInputElement>(null);

  const onPickJson = () => jsonInputRef.current?.click();
  const onPickGan = () => ganInputRef.current?.click();

  const handleJson = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text) as unknown;
      // Normalize BEFORE validation (G1): backfill missing optional fields so
      // older files pass AJV. Holiday backfill is injected via getHolidays.
      const normalized = normalizeFile(data as GanttlyFile, { getHolidays });
      const result = validateGanttlyFile(normalized);
      if (!result.ok) {
        window.alert(t('errors.importFailed', { reason: formatAjvErrors(result.errors) }));
        return;
      }
      setFile(normalized);
      await save();
    } catch (err) {
      window.alert(t('errors.importFailed', { reason: (err as Error).message }));
    }
  };

  const handleGan = async (file: File) => {
    try {
      const text = await file.text();
      const result = parseGan(text);
      // Apply bundled zh-CN calendar (PRD: ignore source calendar, use ours).
      const file2 = result.file;
      file2.calendar = getCalendar('zh-CN');
      // Normalize for future P1 field defaults (holidays already set above; the
      // normalize call keeps .gan imports consistent with the JSON path).
      const normalized = normalizeFile(file2, { getHolidays });
      setFile(normalized);
      await save();
      // Surface what was dropped.
      if (result.skipped.length > 0) {
        window.alert(
          `已导入 ${result.taskCount} 个任务。以下内容未导入:\n${result.skipped.join('\n')}`,
        );
      }
    } catch (err) {
      const reason = err instanceof GanImportError ? err.message : (err as Error).message;
      window.alert(t('errors.importFailed', { reason }));
    }
  };

  return (
    <div className="flex items-center">
      <ToolbarButton onClick={onPickJson} title={t('toolbar.importJson')}>
        {t('toolbar.importJson')}
      </ToolbarButton>
      <ToolbarButton onClick={onPickGan} title={t('toolbar.importGan')}>
        {t('toolbar.importGan')}
      </ToolbarButton>
      <input
        ref={jsonInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleJson(f);
          e.currentTarget.value = '';
        }}
      />
      <input
        ref={ganInputRef}
        type="file"
        accept=".gan,.xml,application/xml,text/xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleGan(f);
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}
