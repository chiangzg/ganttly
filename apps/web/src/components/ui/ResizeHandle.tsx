/**
 * Shared drag-to-resize primitives (plan §3.7 / §4.1).
 *
 * - {@link startPointerResize}: the pointer plumbing every resize handle uses —
 *   window-level pointermove/pointerup listeners with the body cursor and text
 *   selection managed during the drag (mirrors TaskDrawer.tsx:230-249).
 * - {@link ResizeHandle}: the visible separator strip (`role="separator"`),
 *   wired to {@link startPointerResize}; double-click resets to the default.
 * - {@link ResizableHeaderCell}: a table header cell whose right edge is
 *   draggable (Excel-style column resize); the dragged column keeps the width
 *   while the flexible name column absorbs the delta.
 */
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

export function startPointerResize(
  e: ReactPointerEvent<HTMLElement>,
  opts: {
    startWidth: number;
    /** +1: dragging right widens (handle on the right edge); -1: the reverse. */
    direction?: 1 | -1;
    onResize(width: number): void;
  },
): void {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startWidth = opts.startWidth;
  const dir = opts.direction ?? 1;
  const move = (ev: PointerEvent) => {
    opts.onResize(startWidth + dir * (ev.clientX - startX));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

export interface ResizeHandleProps {
  /** Accessibility label for the separator (i18n'd). */
  ariaLabel: string;
  /** Hover tooltip, usually "double-click to reset" (i18n'd). */
  title: string;
  onResizeStart(e: ReactPointerEvent<HTMLDivElement>): void;
  onReset(): void;
  /** Test hook, e.g. `data-resize="task-panel"`. */
  dataResize?: string;
  className?: string;
}

export function ResizeHandle({
  ariaLabel,
  title,
  onResizeStart,
  onReset,
  dataResize,
  className,
}: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      title={title}
      data-resize={dataResize}
      className={cn(
        'absolute top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/20',
        className,
      )}
      onPointerDown={onResizeStart}
      onDoubleClick={onReset}
    />
  );
}

export interface ResizableHeaderCellProps {
  label: ReactNode;
  /** Current width of the column this cell leads. */
  width: number;
  /** Width restored by double-click (the column's default). */
  defaultWidth: number;
  onWidthChange(width: number): void;
  /** Test hook, e.g. `data-resize="task-col-duration"`. */
  dataResize?: string;
  className?: string;
}

export function ResizableHeaderCell({
  label,
  width,
  defaultWidth,
  onWidthChange,
  dataResize,
  className,
}: ResizableHeaderCellProps) {
  const { t } = useTranslation();
  return (
    <div className={cn('relative border-r border-border px-2 py-1', className)}>
      {label}
      <ResizeHandle
        ariaLabel={t('layout.resizeColumn')}
        title={t('layout.resetColumnWidth')}
        dataResize={dataResize}
        className="-right-1 w-1.5"
        onResizeStart={(e) => startPointerResize(e, { startWidth: width, onResize: onWidthChange })}
        onReset={() => onWidthChange(defaultWidth)}
      />
    </div>
  );
}
