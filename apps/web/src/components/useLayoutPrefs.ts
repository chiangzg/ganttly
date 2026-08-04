/**
 * React hooks around lib/layoutPrefs (plan §4.1). Both hooks key their
 * localStorage reads/writes by the CURRENT project id (activeProjectId), so
 * every project remembers its own table layout, and re-initialize when the
 * project switches. Setters clamp + persist immediately (same convention as
 * the drawer-width pref).
 */
import { useEffect, useState } from 'react';
import { useProjectStore } from '@/store/useProjectStore';
import {
  clampPanelWidth,
  clampColumnWidth,
  loadPanelWidth,
  savePanelWidth,
  loadColumnWidth,
  saveColumnWidth,
  COLUMN_KEYS,
  type PanelKind,
  type ColumnKey,
} from '@/lib/layoutPrefs';

/** Panel width (task/resource table) bound to the current project. */
export function usePanelWidth(kind: PanelKind) {
  const projectId = useProjectStore((s) => s.activeProjectId) ?? '';
  const [width, setWidth] = useState(() => loadPanelWidth(projectId, kind));

  useEffect(() => {
    setWidth(loadPanelWidth(projectId, kind));
  }, [projectId, kind]);

  const setAndSave = (next: number) => {
    const clamped = clampPanelWidth(kind, next);
    setWidth(clamped);
    savePanelWidth(projectId, kind, clamped);
  };

  return [width, setAndSave] as const;
}

/** Adjustable column widths for one panel kind, bound to the current project. */
export function useColumnWidths(kind: PanelKind) {
  const projectId = useProjectStore((s) => s.activeProjectId) ?? '';
  const keys = COLUMN_KEYS[kind];
  const [widths, setWidths] = useState<Partial<Record<ColumnKey, number>>>(() =>
    Object.fromEntries(keys.map((col) => [col, loadColumnWidth(projectId, kind, col)])),
  );

  useEffect(() => {
    setWidths(Object.fromEntries(keys.map((col) => [col, loadColumnWidth(projectId, kind, col)])));
  }, [projectId, kind, keys]);

  const setColumnWidth = (col: ColumnKey, next: number) => {
    const clamped = clampColumnWidth(col, next);
    setWidths((prev) => ({ ...prev, [col]: clamped }));
    saveColumnWidth(projectId, kind, col, clamped);
  };

  return { widths, setColumnWidth };
}
