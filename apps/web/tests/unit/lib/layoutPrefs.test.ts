import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_WIDTHS,
  DEFAULT_COLUMN_WIDTHS,
  MIN_PANEL_WIDTHS,
  MAX_PANEL_WIDTHS,
  clampPanelWidth,
  loadPanelWidth,
  savePanelWidth,
  clampColumnWidth,
  loadColumnWidth,
  saveColumnWidth,
} from '@/lib/layoutPrefs';
import { localRef } from '@/data/projectRef';

const REF = localRef('proj-1');
const PANEL_KEY = `ganttly:preferences:panel-widths:local/local/proj-1`;
const COLUMN_KEY = `ganttly:preferences:column-widths:local/local/proj-1`;

describe('clampPanelWidth', () => {
  it('returns the default for non-finite values', () => {
    expect(clampPanelWidth('task', NaN)).toBe(DEFAULT_PANEL_WIDTHS.task);
    expect(clampPanelWidth('resource', Infinity)).toBe(DEFAULT_PANEL_WIDTHS.resource);
  });

  it('clamps to the per-kind bounds (task 320-720, resource 300-640)', () => {
    expect(clampPanelWidth('task', 0)).toBe(MIN_PANEL_WIDTHS.task);
    expect(clampPanelWidth('task', 9999)).toBe(MAX_PANEL_WIDTHS.task);
    expect(clampPanelWidth('resource', 0)).toBe(MIN_PANEL_WIDTHS.resource);
    expect(clampPanelWidth('resource', 9999)).toBe(MAX_PANEL_WIDTHS.resource);
    expect(clampPanelWidth('task', 500)).toBe(500);
  });
});

describe('loadPanelWidth / savePanelWidth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the default when the key is missing', () => {
    expect(loadPanelWidth(REF, 'task')).toBe(DEFAULT_PANEL_WIDTHS.task);
    expect(loadPanelWidth(REF, 'resource')).toBe(DEFAULT_PANEL_WIDTHS.resource);
  });

  it('round-trips a saved width', () => {
    savePanelWidth(REF, 'task', 620);
    expect(loadPanelWidth(REF, 'task')).toBe(620);
  });

  it('clamps an out-of-range persisted value', () => {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ task: 100 }));
    expect(loadPanelWidth(REF, 'task')).toBe(MIN_PANEL_WIDTHS.task);
    localStorage.setItem(PANEL_KEY, JSON.stringify({ task: 9999 }));
    expect(loadPanelWidth(REF, 'task')).toBe(MAX_PANEL_WIDTHS.task);
  });

  it('falls back to the default for corrupt/empty storage', () => {
    localStorage.setItem(PANEL_KEY, 'not-json');
    expect(loadPanelWidth(REF, 'task')).toBe(DEFAULT_PANEL_WIDTHS.task);
    localStorage.setItem(PANEL_KEY, '');
    expect(loadPanelWidth(REF, 'task')).toBe(DEFAULT_PANEL_WIDTHS.task);
  });

  it('keeps task and resource widths independent (merge on save)', () => {
    savePanelWidth(REF, 'task', 600);
    savePanelWidth(REF, 'resource', 520);
    expect(loadPanelWidth(REF, 'task')).toBe(600);
    expect(loadPanelWidth(REF, 'resource')).toBe(520);
  });

  it('isolates widths per project ref', () => {
    savePanelWidth(REF, 'task', 600);
    expect(loadPanelWidth(localRef('proj-2'), 'task')).toBe(DEFAULT_PANEL_WIDTHS.task);
  });

  it('migrates legacy bare-projectId keys on first read', () => {
    const legacyKey = 'ganttly:preferences:panel-widths:proj-1';
    localStorage.setItem(legacyKey, JSON.stringify({ task: 550 }));
    // New key should not exist yet.
    expect(localStorage.getItem(PANEL_KEY)).toBeNull();
    // Reading triggers migration.
    expect(loadPanelWidth(REF, 'task')).toBe(550);
    // New key is now populated, old key removed.
    expect(localStorage.getItem(PANEL_KEY)).not.toBeNull();
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });
});

describe('clampColumnWidth', () => {
  it('returns the default for non-finite values', () => {
    expect(clampColumnWidth('duration', NaN)).toBe(DEFAULT_COLUMN_WIDTHS.duration);
    expect(clampColumnWidth('role', Infinity)).toBe(DEFAULT_COLUMN_WIDTHS.role);
  });

  it('clamps to the per-column bounds', () => {
    expect(clampColumnWidth('duration', 10)).toBe(40);
    expect(clampColumnWidth('duration', 999)).toBe(160);
    expect(clampColumnWidth('role', 999)).toBe(200); // role allows up to 200
    expect(clampColumnWidth('capacity', 20)).toBe(48);
  });

  it('passes through in-range values (rounded)', () => {
    expect(clampColumnWidth('progress', 56)).toBe(56);
    expect(clampColumnWidth('progress', 55.6)).toBe(56);
  });
});

describe('loadColumnWidth / saveColumnWidth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the default when the key is missing', () => {
    expect(loadColumnWidth(REF, 'task', 'duration')).toBe(DEFAULT_COLUMN_WIDTHS.duration);
    expect(loadColumnWidth(REF, 'resource', 'capacity')).toBe(DEFAULT_COLUMN_WIDTHS.capacity);
  });

  it('round-trips a saved width', () => {
    saveColumnWidth(REF, 'task', 'duration', 120);
    expect(loadColumnWidth(REF, 'task', 'duration')).toBe(120);
  });

  it('clamps an out-of-range persisted value', () => {
    localStorage.setItem(COLUMN_KEY, JSON.stringify({ task: { duration: 10 } }));
    expect(loadColumnWidth(REF, 'task', 'duration')).toBe(40);
  });

  it('falls back to the default for corrupt storage', () => {
    localStorage.setItem(COLUMN_KEY, '{oops');
    expect(loadColumnWidth(REF, 'task', 'duration')).toBe(DEFAULT_COLUMN_WIDTHS.duration);
  });

  it('merges columns and kinds on save', () => {
    saveColumnWidth(REF, 'task', 'duration', 120);
    saveColumnWidth(REF, 'task', 'effort', 80);
    saveColumnWidth(REF, 'resource', 'role', 140);
    expect(loadColumnWidth(REF, 'task', 'duration')).toBe(120);
    expect(loadColumnWidth(REF, 'task', 'effort')).toBe(80);
    expect(loadColumnWidth(REF, 'task', 'progress')).toBe(DEFAULT_COLUMN_WIDTHS.progress);
    expect(loadColumnWidth(REF, 'resource', 'role')).toBe(140);
  });

  afterEach(() => {
    localStorage.clear();
  });
});
