/**
 * Searchable dropdown ("combobox") used by the task-drawer pickers.
 *
 * Radix Popover + a plain listbox — no new dependency. The defining
 * interaction: selecting an item immediately fires `onSelect` and, with
 * `closeOnSelect={false}`, clears the query and keeps the list open so the
 * user can add several entries in one sitting (dependency / resource
 * pickers). This removes the old two-step "pick from <select>, then press +"
 * flow whose confirmation step users kept forgetting.
 *
 * Keyboard: the search input is focused on open; ArrowUp/Down move the
 * highlight, Enter commits, Escape closes (Radix handles Escape/outside
 * click dismissal). Filtering is delegated to the optional `filter`
 * predicate so callers can plug in pinyin matching.
 */
import * as Popover from '@radix-ui/react-popover';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface ComboboxItem {
  value: string;
  label: string;
  /** Secondary line, e.g. the WBS full path of a task. */
  description?: string;
}

const MAX_RENDERED_ITEMS = 200;

interface ComboboxProps {
  items: ComboboxItem[];
  /**
   * Predicate applied to each item against the current query. Defaults to a
   * case-insensitive substring match over label + description. Receives the
   * raw query — callers doing pinyin matching normalise internally.
   */
  filter?: (item: ComboboxItem, query: string) => boolean;
  /** Text on the closed trigger (e.g. "添加依赖"). */
  placeholder: string;
  /** Placeholder inside the search input. */
  searchPlaceholder: string;
  /** Empty-state line when nothing matches. */
  emptyText: string;
  /** Close the popover after each selection (default true). */
  closeOnSelect?: boolean;
  disabled?: boolean;
  onSelect: (value: string) => void;
}

/**
 * Default filter: whitespace tokens AND-match over label + description, so
 * `任务名称 1` finds 「1 任务名称」 (name matches one token, WBS the other).
 */
function defaultFilter(item: ComboboxItem, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = `${item.label}\n${item.description ?? ''}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function Combobox({
  items,
  filter = defaultFilter,
  placeholder,
  searchPlaceholder,
  emptyText,
  closeOnSelect = true,
  disabled = false,
  onSelect,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filtered = useMemo(
    () => items.filter((item) => filter(item, query)),
    [items, filter, query],
  );
  const visible = filtered.slice(0, MAX_RENDERED_ITEMS);

  // Reset the highlight whenever the result set changes shape (query typed,
  // item added upstream). Parent re-renders swap `items` identity too, so
  // this also re-anchors after a continuous-add selection.
  useEffect(() => {
    setHighlight(0);
  }, [query, items]);

  useEffect(() => {
    optionRefs.current[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const select = (value: string) => {
    onSelect(value);
    if (closeOnSelect) {
      setOpen(false);
    } else {
      setQuery('');
      // Keep the keyboard flow going: refocus the search input after the
      // click so the next query can be typed immediately.
      searchRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' && visible[highlight]) {
      e.preventDefault();
      select(visible[highlight].value);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          className={cn(
            'flex w-full items-center gap-2 rounded border bg-bg px-2 py-1.5 text-left text-[13px]',
            'border-border text-fg-muted hover:border-fg-muted/60',
            open && 'border-primary ring-1 ring-primary/30',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <Search size={14} className="shrink-0" aria-hidden />
          <span className="truncate">{placeholder}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onKeyDown={onKeyDown}
          className="z-50 w-[var(--radix-popover-trigger-width)] rounded-lg border border-border bg-bg-elevated p-1 shadow-xl outline-none"
        >
          <input
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            role="combobox"
            aria-expanded
            aria-controls="ganttly-combobox-list"
            className="mb-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-[13px] outline-none placeholder:text-fg-muted focus:border-primary"
          />
          <div id="ganttly-combobox-list" role="listbox" className="max-h-64 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-fg-muted">{emptyText}</p>
            ) : (
              visible.map((item, index) => (
                <button
                  key={item.value}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  ref={(el) => {
                    optionRefs.current[index] = el;
                  }}
                  onMouseMove={() => setHighlight(index)}
                  onClick={() => select(item.value)}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left outline-none',
                    index === highlight && 'bg-accent/10',
                  )}
                >
                  <span className="w-full truncate text-[13px]">{item.label}</span>
                  {item.description ? (
                    <span className="w-full truncate text-xs text-fg-muted">
                      {item.description}
                    </span>
                  ) : null}
                </button>
              ))
            )}
            {filtered.length > MAX_RENDERED_ITEMS && (
              <p className="px-2 py-1 text-center text-xs text-fg-muted">
                +{filtered.length - MAX_RENDERED_ITEMS}
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
