import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  pressed?: boolean;
  variant?: 'ghost' | 'subtle' | 'primary';
  size?: 'icon' | 'compact' | 'default';
}

export const ToolbarButton = forwardRef<HTMLButtonElement, Props>(function ToolbarButton(
  { children, pressed, variant = 'ghost', size = 'default', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      aria-pressed={pressed}
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium outline-none transition',
        'focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-elevated',
        'disabled:pointer-events-none disabled:opacity-35',
        size === 'icon' && 'w-8 p-0',
        size === 'compact' && 'px-2',
        size === 'default' && 'px-2.5',
        variant === 'ghost' && 'text-fg-muted hover:bg-bg hover:text-fg',
        variant === 'subtle' && 'bg-bg text-fg hover:bg-border/55',
        variant === 'primary' &&
          'bg-primary text-white shadow-sm shadow-primary/15 hover:bg-primary/90 active:translate-y-px',
        pressed && variant !== 'primary' && 'bg-primary/10 text-primary hover:bg-primary/15',
        className,
      )}
    >
      {children}
    </button>
  );
});
