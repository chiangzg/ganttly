import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  pressed?: boolean;
}

export const ToolbarButton = forwardRef<HTMLButtonElement, Props>(function ToolbarButton(
  { children, pressed, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      className={cn(
        'shrink-0 whitespace-nowrap rounded px-2 py-1 text-sm transition-colors',
        'border border-transparent',
        'hover:bg-bg hover:text-fg',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        pressed && 'border-primary bg-bg text-primary',
        className,
      )}
    >
      {children}
    </button>
  );
});
