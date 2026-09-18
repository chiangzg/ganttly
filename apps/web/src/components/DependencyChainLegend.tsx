/**
 * Dependency-chain legend (dependency-chain spec §3.6).
 *
 * A small glassy pill pinned to the bottom-right of the task-view canvas that
 * explains the two chain colors while a highlight is active: emerald = settled
 * upstream (已完成路径), cyan with a CSS ping = propagating downstream (向下传递),
 * plus the member counts. Purely informational — `pointer-events-none` so it
 * never blocks canvas interaction. The downstream dot's ping stops under
 * prefers-reduced-motion via Tailwind's motion-reduce variant, mirroring the
 * canvas renderer's own degradation (§3.7).
 */
import { useTranslation } from 'react-i18next';

export interface DepChainLegendInfo {
  upstreamCount: number;
  downstreamCount: number;
}

export function DependencyChainLegend({ info }: { info: DepChainLegendInfo | null }) {
  const { t } = useTranslation();
  if (!info) return null;
  return (
    <div
      data-testid="dep-chain-legend"
      className="pointer-events-none absolute bottom-4 right-5 z-10 flex items-center gap-3 rounded-full border border-border/70 bg-bg-elevated/80 px-3 py-1.5 text-xs shadow-lg backdrop-blur-md"
    >
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: 'rgb(var(--color-dep-upstream))' }}
        />
        <span className="text-fg-muted">{t('canvas.depChainUpstream')}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="relative flex h-2 w-2">
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
            style={{ backgroundColor: 'rgb(var(--color-dep-downstream))' }}
          />
          <span
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ backgroundColor: 'rgb(var(--color-dep-downstream))' }}
          />
        </span>
        <span className="text-fg-muted">{t('canvas.depChainDownstream')}</span>
      </span>
      <span className="border-l border-border pl-3 text-fg-muted">
        {t('canvas.depChainCounts', {
          upstream: info.upstreamCount,
          downstream: info.downstreamCount,
        })}
      </span>
    </div>
  );
}
