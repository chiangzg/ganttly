/**
 * Preset task-color palette for the drawer's color swatches (drawer redesign).
 *
 * Mid-saturation tones that stay legible on both light and dark themes and
 * read as distinct when rendered as task-bar fills on the canvas. The first
 * entry is the historical default (`--color-task-bar` light value), kept as
 * `DEFAULT_TASK_COLOR` so existing tasks don't shift appearance.
 */
export const TASK_COLOR_PALETTE: ReadonlyArray<string> = [
  '#60a5fa', // blue
  '#818cf8', // indigo
  '#a78bfa', // violet
  '#f472b6', // pink
  '#fb7185', // rose
  '#fb923c', // orange
  '#fbbf24', // amber
  '#34d399', // emerald
  '#2dd4bf', // teal
  '#94a3b8', // slate
];

export const DEFAULT_TASK_COLOR = '#60a5fa';
