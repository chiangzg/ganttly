/**
 * Preset color swatch grid with a custom-color escape hatch — the
 * Notion/Linear/Jira-label pattern: one click applies a curated color; the
 * rainbow tile delegates to the OS color picker (`input[type=color]`, which
 * ships an eyedropper on macOS/Windows) instead of asking users to type RGB.
 *
 * `value === undefined` means "auto" (theme default task-bar color); the
 * first cell restores that. Swatches expose their hex as the accessible name
 * so tests and screen readers get a stable, language-neutral handle.
 */
import { Ban, Check, Pipette } from 'lucide-react';
import { useRef } from 'react';
import { cn } from '@/lib/cn';
import { DEFAULT_TASK_COLOR, TASK_COLOR_PALETTE } from '@/lib/taskColors';

interface ColorSwatchPickerProps {
  /** Selected CSS color; undefined = follow theme default. */
  value?: string;
  onChange: (color: string | undefined) => void;
  /** Accessible label for the "auto" cell. */
  defaultLabel: string;
  /** Accessible label for the OS-picker tile. */
  customLabel: string;
}

function isLightColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1] ?? '', 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

export function ColorSwatchPicker({
  value,
  onChange,
  defaultLabel,
  customLabel,
}: ColorSwatchPickerProps) {
  const customInputRef = useRef<HTMLInputElement>(null);

  const swatchClass = (selected: boolean) =>
    cn(
      'flex h-[22px] w-[22px] items-center justify-center rounded border border-black/10 transition-transform',
      'hover:scale-110',
      selected && 'outline outline-2 outline-offset-1 outline-primary',
    );

  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        aria-label={defaultLabel}
        title={defaultLabel}
        aria-pressed={value === undefined}
        onClick={() => onChange(undefined)}
        className={cn(
          'flex h-[22px] w-[22px] items-center justify-center rounded border border-border bg-bg text-fg-muted transition-transform hover:scale-110',
          value === undefined && 'outline outline-2 outline-offset-1 outline-primary',
        )}
      >
        <Ban size={12} aria-hidden />
      </button>

      {TASK_COLOR_PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          title={color}
          aria-pressed={value === color}
          onClick={() => onChange(color)}
          className={swatchClass(value === color)}
          style={{ backgroundColor: color }}
        >
          {value === color && (
            <Check
              size={13}
              aria-hidden
              className={isLightColor(color) ? 'text-slate-900' : 'text-white'}
            />
          )}
        </button>
      ))}

      <button
        type="button"
        aria-label={customLabel}
        title={customLabel}
        onClick={() => customInputRef.current?.click()}
        className={cn(
          'flex h-[22px] w-[22px] items-center justify-center rounded border border-border text-white',
          'bg-[conic-gradient(from_180deg,#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f472b6,#f87171)] transition-transform hover:scale-110',
          value !== undefined &&
            !TASK_COLOR_PALETTE.includes(value) &&
            'outline outline-2 outline-offset-1 outline-primary',
        )}
      >
        <Pipette size={12} aria-hidden className="drop-shadow" />
      </button>

      {/* Hidden native picker: only opened via the rainbow tile above. */}
      <input
        ref={customInputRef}
        type="color"
        value={value ?? DEFAULT_TASK_COLOR}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
      />
    </div>
  );
}
