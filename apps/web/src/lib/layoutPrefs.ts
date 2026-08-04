/**
 * Panel/column-width localStorage persistence + bounds (editor-interaction-
 * optimization-plan §4.1).
 *
 * Layout widths are USER PREFERENCES, not project data: they do not go into
 * the project file, the undo stack, or the exported JSON. Per the plan they are
 * keyed by PROJECT id (`ganttly:preferences:*:<projectId>`) so each project
 * remembers its own table layout — unlike the drawer-width pref, which
 * predates §4.1 and stays on a global key.
 *
 * Bounds per plan §4.1: task table 320-720px (default 480), resource table
 * 300-640px (default 420); key columns (duration/effort/progress/baseline,
 * role/capacity) are adjustable via header separators. The task-name column is
 * deliberately NOT stored: it stays `minmax(0, 1fr)` and absorbs every panel/
 * column delta, so the grid never shows empty space at any width.
 *
 * Pure functions so load/save/clamp is unit-testable without a store.
 */

export type PanelKind = 'task' | 'resource';

export const DEFAULT_PANEL_WIDTHS: Record<PanelKind, number> = { task: 480, resource: 420 };
export const MIN_PANEL_WIDTHS: Record<PanelKind, number> = { task: 320, resource: 300 };
export const MAX_PANEL_WIDTHS: Record<PanelKind, number> = { task: 720, resource: 640 };

const PANEL_STORAGE_PREFIX = 'ganttly:preferences:panel-widths:';

export function clampPanelWidth(kind: PanelKind, width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PANEL_WIDTHS[kind];
  return Math.max(MIN_PANEL_WIDTHS[kind], Math.min(MAX_PANEL_WIDTHS[kind], Math.round(width)));
}

/** Read the persisted panel widths for a project; null when missing/corrupt. */
function readPanelWidths(key: string): Partial<Record<PanelKind, number>> | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw.trim() === '') return null;
    const parsed = JSON.parse(raw) as Record<PanelKind, number>;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Load one panel's persisted width, falling back to the default. */
export function loadPanelWidth(projectId: string, kind: PanelKind): number {
  const widths = readPanelWidths(PANEL_STORAGE_PREFIX + projectId);
  const n = widths?.[kind];
  if (typeof n !== 'number') return DEFAULT_PANEL_WIDTHS[kind];
  return clampPanelWidth(kind, n);
}

/** Persist one panel's width (merges with the other panel's saved value). */
export function savePanelWidth(projectId: string, kind: PanelKind, width: number): void {
  try {
    const key = PANEL_STORAGE_PREFIX + projectId;
    const current = readPanelWidths(key) ?? {};
    localStorage.setItem(key, JSON.stringify({ ...current, [kind]: clampPanelWidth(kind, width) }));
  } catch {
    /* ignore — preference persistence is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Column widths
// ---------------------------------------------------------------------------

export type TaskColumnKey = 'duration' | 'effort' | 'progress' | 'baseline';
export type ResourceColumnKey = 'role' | 'capacity';
export type ColumnKey = TaskColumnKey | ResourceColumnKey;

/** Default widths — identical to the pre-§4.1 fixed grid templates. */
export const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  duration: 72,
  effort: 56,
  progress: 56,
  baseline: 70,
  role: 76,
  // 64 → 72: room for the % unit suffix added alongside the capacity input
  // (plan §5.3) plus the number-input spinner.
  capacity: 72,
};

export const COLUMN_BOUNDS: Record<ColumnKey, { min: number; max: number }> = {
  duration: { min: 40, max: 160 },
  effort: { min: 40, max: 160 },
  progress: { min: 40, max: 160 },
  baseline: { min: 48, max: 160 },
  role: { min: 48, max: 200 },
  capacity: { min: 48, max: 160 },
};

/** The adjustable column keys per panel kind (task name is never adjustable). */
export const COLUMN_KEYS: Record<PanelKind, readonly ColumnKey[]> = {
  task: ['duration', 'effort', 'progress', 'baseline'],
  resource: ['role', 'capacity'],
};

const COLUMN_STORAGE_PREFIX = 'ganttly:preferences:column-widths:';

export function clampColumnWidth(col: ColumnKey, width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_COLUMN_WIDTHS[col];
  const { min, max } = COLUMN_BOUNDS[col];
  return Math.max(min, Math.min(max, Math.round(width)));
}

function readColumnWidths(
  key: string,
): Partial<Record<PanelKind, Partial<Record<ColumnKey, number>>>> | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw.trim() === '') return null;
    const parsed = JSON.parse(raw) as Record<PanelKind, Partial<Record<ColumnKey, number>>>;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Load one column's persisted width, falling back to its default. */
export function loadColumnWidth(projectId: string, kind: PanelKind, col: ColumnKey): number {
  const widths = readColumnWidths(COLUMN_STORAGE_PREFIX + projectId);
  const n = widths?.[kind]?.[col];
  if (typeof n !== 'number') return DEFAULT_COLUMN_WIDTHS[col];
  return clampColumnWidth(col, n);
}

/** Persist one column's width (merges with every other saved column). */
export function saveColumnWidth(
  projectId: string,
  kind: PanelKind,
  col: ColumnKey,
  width: number,
): void {
  try {
    const key = COLUMN_STORAGE_PREFIX + projectId;
    const current: Partial<Record<PanelKind, Partial<Record<ColumnKey, number>>>> =
      readColumnWidths(key) ?? {};
    current[kind] = { ...current[kind], [col]: clampColumnWidth(col, width) };
    localStorage.setItem(key, JSON.stringify(current));
  } catch {
    /* ignore — preference persistence is best-effort */
  }
}
