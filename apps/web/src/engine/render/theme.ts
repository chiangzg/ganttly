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
