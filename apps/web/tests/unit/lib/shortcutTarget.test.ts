import { describe, expect, it } from 'vitest';
import { isEditableTarget } from '@/lib/shortcutTarget';

/**
 * isEditableTarget decides whether a global/row/canvas keydown handler should
 * stand aside and let a focused text element handle the key itself (plan §4.2).
 * Cover every element kind the editor renders.
 */
describe('isEditableTarget', () => {
  function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  it('returns false for null / non-element targets', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
    expect(isEditableTarget(document.createTextNode('hi') as unknown as EventTarget)).toBe(false);
  });

  it('returns true for a plain text input and a default (no type) input', () => {
    expect(isEditableTarget(el('input', { type: 'text' }))).toBe(true);
    expect(isEditableTarget(el('input'))).toBe(true); // no type attr → text
  });

  it('returns true for number/email/password/search/tel/url/date inputs', () => {
    for (const type of ['number', 'email', 'password', 'search', 'tel', 'url', 'date']) {
      expect(isEditableTarget(el('input', { type }))).toBe(true);
    }
  });

  it('returns false for non-text inputs (button/checkbox/radio/range)', () => {
    // These do not edit text and must NOT block task shortcuts — e.g. the
    // milestone checkbox in the drawer should not swallow a task Delete.
    for (const type of ['checkbox', 'radio', 'button', 'range', 'file', 'submit', 'image']) {
      expect(isEditableTarget(el('input', { type }))).toBe(false);
    }
  });

  it('returns true for textarea and select', () => {
    expect(isEditableTarget(el('textarea'))).toBe(true);
    expect(isEditableTarget(el('select'))).toBe(true);
  });

  it('returns true for a contenteditable div', () => {
    const div = el('div');
    div.setAttribute('contenteditable', 'true');
    expect(isEditableTarget(div)).toBe(true);
  });

  it('returns false for an ordinary div, span, button, and the canvas', () => {
    expect(isEditableTarget(el('div'))).toBe(false);
    expect(isEditableTarget(el('span'))).toBe(false);
    expect(isEditableTarget(el('button'))).toBe(false);
    expect(isEditableTarget(el('canvas'))).toBe(false);
  });

  it('returns false for a table row (the task row itself)', () => {
    expect(isEditableTarget(el('div', { role: 'row' }))).toBe(false);
  });
});
