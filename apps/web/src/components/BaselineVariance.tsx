/**
 * BaselineVariance — small reusable display helpers for baseline deviations
 * (baseline-comparison spec §6.8).
 *
 * These components format deviation text/symbols so TaskTable, TaskDrawer and
 * tooltips share ONE presentation. They MUST consume the same pure functions
 * in `@/lib/baseline` so values never drift between surfaces.
 *
 * Visual rules (spec §5.6, §5.10):
 * - Red/green are reserved for delay/early NUMERIC results only.
 * - A Unicode minus `−` (U+2212) is used for negative display for better
 *   alignment, but tests/calculations always use plain numbers (spec §6.10).
 * - Never rely on color alone: every state also shows `+/-`, a number, or 新增.
 */
import type { TFunction } from 'i18next';
import type { TaskBaselineVariance } from '@/lib/baseline';

/** Unicode minus for display (tests use plain `-`). */
const MINUS = '\u2212';

/**
 * Format a signed working-day delta for display, e.g. `+3 天`, `−2 天`, `0`.
 * Positive → danger tone, negative → success tone, zero → muted. The unit comes
 * from the caller's translation function (`baseline.deltaDays`).
 */
export function formatDelta(
  delta: number,
  t: TFunction,
): { text: string; tone: 'danger' | 'success' | 'muted' } {
  if (delta > 0) return { text: t('baseline.deltaDays', { n: `+${delta}` }), tone: 'danger' };
  if (delta < 0)
    return { text: t('baseline.deltaDays', { n: `${MINUS}${Math.abs(delta)}` }), tone: 'success' };
  return { text: '0', tone: 'muted' };
}

/** Tailwind text-color class for a tone. */
export function toneClass(tone: 'danger' | 'success' | 'muted'): string {
  if (tone === 'danger') return 'text-danger';
  if (tone === 'success') return 'text-success';
  return 'text-fg-muted';
}

/**
 * The single-cell summary shown in the TaskTable deviation column (spec §5.6).
 * Returns the display token + tone for a task's variance:
 * - `late`    → `+3 天` (danger)
 * - `early`   → `−2 天` (success)
 * - `on-track`→ `—`     (muted)
 * - `added`   → `新增`  (primary)
 */
export function deviationColumnCell(
  v: TaskBaselineVariance,
  t: TFunction,
): {
  text: string;
  tone: 'danger' | 'success' | 'muted' | 'primary';
} {
  if (v.status === 'added') return { text: t('baseline.deviationAdded'), tone: 'primary' };
  const f = formatDelta(v.finishDelta, t);
  // On-track renders as an em dash, not "0 天".
  if (v.status === 'on-track') return { text: '—', tone: 'muted' };
  return { text: f.text, tone: f.tone };
}

/** Color class including the `primary` tone used by "新增". */
export function deviationToneClass(tone: 'danger' | 'success' | 'muted' | 'primary'): string {
  if (tone === 'primary') return 'text-primary';
  return toneClass(tone);
}

/**
 * Multi-line detail text for a variance, used in tooltips (TaskTable hover,
 * Canvas hover). Each line is `label: value`.
 */
export function varianceDetailLines(
  v: TaskBaselineVariance,
  t: TFunction,
): Array<{ label: string; value: string }> {
  if (v.status === 'added') {
    return [{ label: t('baseline.statusLabel'), value: t('baseline.addedTask') }];
  }
  return [
    { label: t('baseline.varianceStart'), value: formatDelta(v.startDelta, t).text },
    { label: t('baseline.varianceFinish'), value: formatDelta(v.finishDelta, t).text },
    { label: t('baseline.varianceDuration'), value: formatDelta(v.durationDelta, t).text },
  ];
}
