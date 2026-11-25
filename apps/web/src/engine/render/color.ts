/**
 * Color helpers shared by the Canvas renderer and the DOM task marks, so the
 * "progress = task color darkened" rule (approved behaviour, see
 * `progress-fill-task-color`) has exactly one implementation.
 */

/** Darken a color by ~20%. Accepts hex (#RRGGBB) or rgb(). */
export function darken(color: string): string {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1]!, 16);
    const r = Math.floor(((n >> 16) & 0xff) * 0.8);
    const g = Math.floor(((n >> 8) & 0xff) * 0.8);
    const b = Math.floor((n & 0xff) * 0.8);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const rgb = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map((v) => Math.floor(Number(v) * 0.8));
    return `rgb(${r}, ${g}, ${b})`;
  }
  return color;
}
