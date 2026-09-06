/**
 * Pinyin-aware substring matcher for drawer pickers (resources, tasks).
 *
 * Matches a name against a query in three forms so Chinese names can be
 * searched the way people actually type: the name itself, full pinyin
 * (`蒋志国` → `jiangzhiguo`) and pinyin initials (`蒋志国` → `jzg`).
 * Matching is case-insensitive; `ü` is normalised to `v` on both sides so
 * `lv`/`lü` queries both find 吕姓.
 *
 * Resource lists are small (tens of entries), so per-name forms are computed
 * lazily and memoised in a module-level cache keyed by the raw name.
 */
import { pinyin } from 'pinyin-pro';

interface PinyinForms {
  /** Full pinyin, no tones, no separators: `jiangzhiguo`. */
  full: string;
  /** Pinyin initials: `jzg`. */
  initials: string;
}

const formsCache = new Map<string, PinyinForms>();

function getPinyinForms(name: string): PinyinForms {
  let forms = formsCache.get(name);
  if (!forms) {
    const opts = { toneType: 'none', type: 'string', separator: '', v: true } as const;
    forms = {
      full: pinyin(name, opts).toLowerCase(),
      initials: pinyin(name, { ...opts, pattern: 'first' }).toLowerCase(),
    };
    formsCache.set(name, forms);
  }
  return forms;
}

/** Normalize a query the same way the cached forms are normalised. */
function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/ü/g, 'v');
}

/**
 * True when `name` matches `query` by raw text, full pinyin, or pinyin
 * initials. The query is split on whitespace and every token must match
 * (AND), so `任务 1` finds 「1 任务名称」 and `jiang zhi` finds 蒋志国.
 * Empty/whitespace queries match everything.
 */
export function matchPinyin(name: string, query: string): boolean {
  const tokens = normalizeQuery(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const lowerName = name.toLowerCase();
  const { full, initials } = getPinyinForms(name);
  return tokens.every((token) => {
    if (lowerName.includes(token)) return true;
    return full.includes(token) || initials.includes(token);
  });
}
