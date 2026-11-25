/**
 * Initials avatar with a stable name-hashed palette.
 *
 * Extracted from ResourceList (people-centric resource rows) so the priority
 * matrix cards can show task assignees in exactly the same colours — the same
 * person must look the same in every view.
 */
import { cn } from '@/lib/cn';

/**
 * Soft 15% fills read on both light and dark themes.
 */
const AVATAR_COLORS = [
  'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
] as const;

function avatarColorOf(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

/** "孟祥俊" → 孟, "Zhang San" → ZS, "Alice" → A. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return words[0]![0]!.toUpperCase();
}

/** Decorative (aria-hidden): the name is always available as text next to it. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 select-none items-center justify-center rounded-full text-[10px] font-semibold',
        avatarColorOf(name),
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
