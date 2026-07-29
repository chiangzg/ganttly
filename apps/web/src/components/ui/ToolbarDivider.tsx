export function ToolbarDivider({ className = '' }: { className?: string }) {
  return <div className={`mx-1 h-5 w-px shrink-0 bg-border/80 ${className}`} aria-hidden="true" />;
}
