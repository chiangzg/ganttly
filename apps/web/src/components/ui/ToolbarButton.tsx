import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  pressed?: boolean;
}

export function ToolbarButton({ children, pressed, className, ...rest }: Props) {
  return (
    <button
      {...rest}
      className={cn(
        'rounded px-2 py-1 text-sm transition-colors',
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
}
