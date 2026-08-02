/**
 * Resource load-chart legend (editor-interaction-optimization-plan §5.3).
 *
 * The load chart encodes state with color (green = within capacity, red =
 * overload) plus a dashed capacity reference line. Color alone is not an
 * accessible signal, so this compact legend explains all three encodings with
 * text labels. It also makes the "%" capacity unit explicit (the renderer
 * stores capacity as 0-1; the list shows a bare number).
 *
 * Rendered as an overlay inside ResourceLoadCanvas (top-right), kept
 * pointer-events-none so it never intercepts canvas clicks/drags. The swatches
 * reuse the renderer's literal fill colors so the legend matches the bars
 * exactly in both light and dark themes (the bar colors are theme-independent
 * constants by design — see resourceLoad.ts GREEN/RED).
 */
import { useTranslation } from 'react-i18next';

/** Bar fill colors — kept in sync with resourceLoad.ts GREEN/RED. */
const GREEN = '#22c55e';
const RED = '#ef4444';

export function ResourceLegend() {
  const { t } = useTranslation();
  return (
    <div
      role="note"
      aria-label={t('resource.legendLabel')}
      className="pointer-events-none absolute right-2 top-2 z-20 flex flex-col gap-1 rounded-md border border-border bg-bg-elevated/90 px-2 py-1.5 text-[10px] text-fg shadow-sm backdrop-blur-sm"
    >
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm"
          style={{ backgroundColor: GREEN }}
          aria-hidden
        />
        <span>{t('resource.legendWithinCapacity')}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm"
          style={{ backgroundColor: RED }}
          aria-hidden
        />
        <span>{t('resource.legendOverload')}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-2.5 w-3"
          style={{
            borderTop: `1.5px dashed ${'currentColor'}`,
            // A muted dashed line mirrors the renderer's capacity reference line
            // (drawn with theme.fgMuted at 0.35 alpha). Using currentColor keeps
            // it legible in both light/dark; the swatch only signals "dashed".
            opacity: 0.55,
          }}
          aria-hidden
        />
        <span>{t('resource.legendCapacityLine')}</span>
      </div>
    </div>
  );
}
