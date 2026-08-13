/**
 * React hooks around lib/layoutPrefs (plan §4.1). Both hooks key their
 * localStorage reads/writes by the CURRENT project ref (activeProjectRef), so
 * every project in every instance/workspace remembers its own table layout,
 * and re-initialize when the project switches. Setters clamp + persist
 * immediately (same convention as the drawer-width pref).
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
import type { ProjectRef } from '@/data/projectRef';

const PLACEHOLDER_REF: ProjectRef = { instanceId: 'local', workspaceId: 'local', projectId: '' };

/** Panel width (task/resource table) bound to the current project. */
export function usePanelWidth(kind: PanelKind) {
  const ref = useProjectStore((s) => s.activeProjectRef) ?? PLACEHOLDER_REF;
  const [width, setWidth] = useState(() => loadPanelWidth(ref, kind));

  useEffect(() => {
    setWidth(loadPanelWidth(ref, kind));
  }, [ref, kind]);

  const setAndSave = (next: number) => {
    const clamped = clampPanelWidth(kind, next);
    setWidth(clamped);
    savePanelWidth(ref, kind, clamped);
  };

  return [width, setAndSave] as const;
}

/** Adjustable column widths for one panel kind, bound to the current project. */
export function useColumnWidths(kind: PanelKind) {
  const ref = useProjectStore((s) => s.activeProjectRef) ?? PLACEHOLDER_REF;
  const keys = COLUMN_KEYS[kind];
  const [widths, setWidths] = useState<Partial<Record<ColumnKey, number>>>(() =>
    Object.fromEntries(keys.map((col) => [col, loadColumnWidth(ref, kind, col)])),
  );

  useEffect(() => {
    setWidths(Object.fromEntries(keys.map((col) => [col, loadColumnWidth(ref, kind, col)])));
  }, [ref, kind, keys]);

  const setColumnWidth = (col: ColumnKey, next: number) => {
    const clamped = clampColumnWidth(col, next);
    setWidths((prev) => ({ ...prev, [col]: clamped }));
    saveColumnWidth(ref, kind, col, clamped);
  };

  return { widths, setColumnWidth };
}
