/**
 * Drawer-width localStorage persistence + bounds (editor-interaction-optimization-
 * plan §3.7 / §6 / §9.1).
 *
 * Layout width is a USER PREFERENCE, not project data: it does not go into the
 * project file, the undo stack, or the exported JSON. It persists across
 * sessions per-browser via localStorage (mirroring the existing
 * `ganttly:preferences:*` key convention used by project-navigation).
 *
 * The width bounds live HERE (not in the store) so the store can import them
 * without a circular dependency: store → prefs (load/save/constants), prefs →
 * (nothing internal). Pure functions so the load/save/clamp logic is unit-
 * testable without a store.
 */

/** Default docked-inspector width (plan §3.7 "默认宽度约 360px"). */
export const DEFAULT_DRAWER_WIDTH = 360;
/** Minimum resizable width (plan §3.7 "320-480px"). */
export const MIN_DRAWER_WIDTH = 320;
/** Maximum resizable width (plan §3.7 "320-480px"). */
export const MAX_DRAWER_WIDTH = 480;

const STORAGE_KEY = 'ganttly:preferences:drawer-width';

/** Clamp a width into the allowed [MIN, MAX] range. */
export function clampDrawerWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DRAWER_WIDTH;
  return Math.max(MIN_DRAWER_WIDTH, Math.min(MAX_DRAWER_WIDTH, Math.round(width)));
}

/**
 * Read the persisted drawer width. Returns DEFAULT_DRAWER_WIDTH when the key is
 * missing, empty, or fails to parse/clamp (defensive against corrupt values).
 */
export function loadDrawerWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Missing or empty/whitespace string = no preference → default. (Note:
    // `Number('')` is 0, which would otherwise clamp to MIN, so guard it out.)
    if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_DRAWER_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_DRAWER_WIDTH;
    return clampDrawerWidth(n);
  } catch {
    // localStorage may be unavailable (private mode, disabled) — fall back.
    return DEFAULT_DRAWER_WIDTH;
  }
}

/** Persist the drawer width (best-effort; failures are silently ignored). */
export function saveDrawerWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampDrawerWidth(width)));
  } catch {
    /* ignore — preference persistence is best-effort */
  }
}
