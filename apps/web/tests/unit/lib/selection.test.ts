import { describe, expect, it } from 'vitest';
import { computeSelectionOnPointerDown } from '@/lib/selection';

const VISIBLE = ['a', 'b', 'c', 'd', 'e'];
const none = { ctrl: false, meta: false, shift: false };

describe('computeSelectionOnPointerDown — plain click', () => {
  it('selects only the clicked task and sets it as anchor', () => {
    const result = computeSelectionOnPointerDown(
      'c',
      none,
      { ids: new Set(['a', 'b']), anchor: 'a' },
      VISIBLE,
    );
    expect([...result.ids]).toEqual(['c']);
    expect(result.anchor).toBe('c');
  });

  it('replaces an existing multi-selection with a single task', () => {
    const result = computeSelectionOnPointerDown(
      'd',
      none,
      { ids: new Set(['a', 'b', 'c']), anchor: 'a' },
      VISIBLE,
    );
    expect(result.ids.size).toBe(1);
    expect(result.ids.has('d')).toBe(true);
    expect(result.anchor).toBe('d');
  });
});

describe('computeSelectionOnPointerDown — Ctrl/Cmd toggle', () => {
  it('adds a task to the set, keeping the existing anchor', () => {
    const result = computeSelectionOnPointerDown(
      'b',
      { ctrl: true, meta: false, shift: false },
      { ids: new Set(['a']), anchor: 'a' },
      VISIBLE,
    );
    expect(result.ids.has('a')).toBe(true);
    expect(result.ids.has('b')).toBe(true);
    expect(result.anchor).toBe('a');
  });

  it('removes a task from the set', () => {
    const result = computeSelectionOnPointerDown(
      'b',
      { ctrl: false, meta: true, shift: false },
      { ids: new Set(['a', 'b', 'c']), anchor: 'a' },
      VISIBLE,
    );
    expect(result.ids.has('b')).toBe(false);
    expect(result.ids.has('a')).toBe(true);
    expect(result.ids.has('c')).toBe(true);
    expect(result.anchor).toBe('a'); // anchor untouched
  });

  it('degrades the anchor when the anchor itself is removed', () => {
    const result = computeSelectionOnPointerDown(
      'a',
      { ctrl: true, meta: false, shift: false },
      { ids: new Set(['a', 'b', 'c']), anchor: 'a' },
      VISIBLE,
    );
    expect(result.ids.has('a')).toBe(false);
    expect(result.anchor).not.toBe(null);
    expect(result.ids.has(result.anchor as string)).toBe(true);
  });

  it('empties the set and clears the anchor when the last member is removed', () => {
    const result = computeSelectionOnPointerDown(
      'a',
      { ctrl: true, meta: false, shift: false },
      { ids: new Set(['a']), anchor: 'a' },
      VISIBLE,
    );
    expect(result.ids.size).toBe(0);
    expect(result.anchor).toBe(null);
  });

  it('seeds the anchor when toggling into an empty selection', () => {
    const result = computeSelectionOnPointerDown(
      'b',
      { ctrl: true, meta: false, shift: false },
      { ids: new Set(), anchor: null },
      VISIBLE,
    );
    expect([...result.ids]).toEqual(['b']);
    expect(result.anchor).toBe('b');
  });
});

describe('computeSelectionOnPointerDown — Shift range', () => {
  it('selects the inclusive range from anchor to clicked task', () => {
    const result = computeSelectionOnPointerDown(
      'd',
      { ctrl: false, meta: false, shift: true },
      { ids: new Set(['a']), anchor: 'a' },
      VISIBLE,
    );
    expect([...result.ids]).toEqual(['a', 'b', 'c', 'd']);
    expect(result.anchor).toBe('a'); // anchor unchanged by Shift
  });

  it('works backwards (clicked task before anchor)', () => {
    const result = computeSelectionOnPointerDown(
      'a',
      { ctrl: false, meta: false, shift: true },
      { ids: new Set(['d']), anchor: 'd' },
      VISIBLE,
    );
    expect([...result.ids]).toEqual(['a', 'b', 'c', 'd']);
    expect(result.anchor).toBe('d');
  });

  it('degrades to a single-select when there is no anchor', () => {
    const result = computeSelectionOnPointerDown(
      'c',
      { ctrl: false, meta: false, shift: true },
      { ids: new Set(), anchor: null },
      VISIBLE,
    );
    expect([...result.ids]).toEqual(['c']);
    expect(result.anchor).toBe('c');
  });

  it('selects just the anchor when shift-clicking the anchor itself', () => {
    const result = computeSelectionOnPointerDown(
      'b',
      { ctrl: false, meta: false, shift: true },
      { ids: new Set(['b']), anchor: 'b' },
      VISIBLE,
    );
    expect([...result.ids]).toEqual(['b']);
  });

  it('respects the visible-order sequence, not tree order', () => {
    // Visible list is reversed relative to insertion — the range must follow
    // what the user actually sees (plan §4.6: "折叠、筛选后保持一致").
    const reversed = ['e', 'd', 'c', 'b', 'a'];
    const result = computeSelectionOnPointerDown(
      'a',
      { ctrl: false, meta: false, shift: true },
      { ids: new Set(['e']), anchor: 'e' },
      reversed,
    );
    expect([...result.ids]).toEqual(['e', 'd', 'c', 'b', 'a']);
  });
});

describe('computeSelectionOnPointerDown — Shift takes priority over Ctrl', () => {
  it('Shift+Ctrl performs a range select, not a toggle', () => {
    const result = computeSelectionOnPointerDown(
      'd',
      { ctrl: true, meta: false, shift: true },
      { ids: new Set(['a']), anchor: 'a' },
      VISIBLE,
    );
    expect([...result.ids]).toEqual(['a', 'b', 'c', 'd']);
    expect(result.anchor).toBe('a');
  });
});
