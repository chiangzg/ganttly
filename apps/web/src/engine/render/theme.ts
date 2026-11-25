/**
 * Resolve CSS-variable color tokens into rgb() strings the renderer can use.
 *
 * Canvas cannot read CSS custom properties directly. This helper queries the
 * computed style of <html> (where the variables live, see styles/index.css)
 * and converts `rgb(var(--color-x))` → concrete `rgb(r, g, b)`.
 */
import type { ThemeColors } from './types';

const COLOR_VARS: Array<{ key: keyof ThemeColors; varName: string }> = [
  { key: 'bg', varName: '--color-bg' },
  { key: 'bgElevated', varName: '--color-bg-elevated' },
  { key: 'border', varName: '--color-border' },
  { key: 'fg', varName: '--color-fg' },
  { key: 'fgMuted', varName: '--color-fg-muted' },
  { key: 'primary', varName: '--color-primary' },
  { key: 'accent', varName: '--color-accent' },
  { key: 'danger', varName: '--color-danger' },
  { key: 'nonWorking', varName: '--color-non-working' },
  { key: 'warning', varName: '--color-warning' },
  { key: 'taskBar', varName: '--color-task-bar' },
  { key: 'taskProgress', varName: '--color-task-progress' },
  { key: 'critical', varName: '--color-critical' },
  { key: 'baseline', varName: '--color-baseline' },
  { key: 'depUpstream', varName: '--color-dep-upstream' },
  { key: 'depDownstream', varName: '--color-dep-downstream' },
  { key: 'priority1', varName: '--color-priority-1' },
  { key: 'priority2', varName: '--color-priority-2' },
  { key: 'priority3', varName: '--color-priority-3' },
  { key: 'priority4', varName: '--color-priority-4' },
];

export function resolveThemeColors(doc: Document = document): ThemeColors {
  const style = doc.documentElement.style;
  const computed = getComputedStyle(doc.documentElement);
  // Hard-coded fallback palette (light theme) for SSR / first paint.
  const fallback: ThemeColors = {
    bg: 'rgb(250, 250, 250)',
    bgElevated: 'rgb(255, 255, 255)',
    border: 'rgb(226, 232, 240)',
    fg: 'rgb(15, 23, 42)',
    fgMuted: 'rgb(100, 116, 139)',
    primary: 'rgb(37, 99, 235)',
    accent: 'rgb(14, 165, 233)',
    danger: 'rgb(220, 38, 38)',
    nonWorking: 'rgb(254, 226, 226)',
    warning: 'rgb(217, 119, 6)',
    taskBar: 'rgb(96, 165, 250)',
    taskProgress: 'rgb(37, 99, 235)',
    critical: 'rgb(220, 38, 38)',
    baseline: 'rgb(100, 116, 139)',
    depUpstream: 'rgb(16, 185, 129)',
    depDownstream: 'rgb(6, 182, 212)',
    priority1: 'rgb(220, 38, 38)',
    priority2: 'rgb(22, 163, 74)',
    priority3: 'rgb(217, 119, 6)',
    priority4: 'rgb(100, 116, 139)',
    todayLine: 'rgb(220, 38, 38)',
  };

  const result: ThemeColors = { ...fallback };
  for (const { key, varName } of COLOR_VARS) {
    const raw = style.getPropertyValue(varName) || computed.getPropertyValue(varName);
    if (raw) {
      result[key] = `rgb(${raw.trim()})`;
    }
  }
  return result;
}
