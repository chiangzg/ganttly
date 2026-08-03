/**
 * Shared empty-state panel (editor-interaction-optimization-plan §5.2).
 *
 * Used by the task table (zero-task CTA + filter-no-match), the resource list
 * (zero-resource hint), and reusable for any future empty region. Visual style
 * mirrors the project-center EmptyState (dashed panel, primary-tinted icon tile,
 * muted description, optional primary CTA) but is generic: callers supply
 * already-localized strings, an optional icon, and an optional action.
 *
 * Theming is via the existing CSS-var tokens (`bg-bg-elevated/50`, `text-fg`,
 * `text-fg-muted`, `primary`, `border-border`) so light/dark adapts for free
 * (plan §5.2: 空状态在亮色、暗色主题下均不遮挡工具栏). The panel sizes to its
 * flex parent; when placed inside a scroll container it centers vertically via
 * `min-h-full`.
 */
import type { ReactNode } from 'react';

export interface EmptyStateAction {
  /** Already-localized button label. */
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  /** Optional leading icon (e.g. `<Plus size={24} />`). Rendered in a tinted tile. */
  icon?: ReactNode;
  /** Already-localized headline. */
  title: string;
  /** Already-localized secondary description. */
  description?: string;
  /** Optional call-to-action button. */
  action?: EmptyStateAction;
  /** Extra className for the outer panel (e.g. to override min-height). */
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={`flex min-h-full w-full flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg-elevated/50 px-6 py-10 text-center ${className ?? ''}`}
    >
      {icon ? (
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {icon}
        </span>
      ) : null}
      <h3 className="mt-4 text-sm font-semibold text-fg">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-xs text-xs leading-5 text-fg-muted">{description}</p>
      ) : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-primary/90"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
