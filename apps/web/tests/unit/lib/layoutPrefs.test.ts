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

const PROJECT = 'proj-1';
const PANEL_KEY = `ganttly:preferences:panel-widths:${PROJECT}`;
const COLUMN_KEY = `ganttly:preferences:column-widths:${PROJECT}`;

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
    expect(clampPanelWidth('resource', 500)).toBe(500);
  });

  it('rounds fractions and keeps boundaries inclusive', () => {
    expect(clampPanelWidth('task', 479.6)).toBe(480);
    expect(clampPanelWidth('task', MIN_PANEL_WIDTHS.task)).toBe(MIN_PANEL_WIDTHS.task);
    expect(clampPanelWidth('task', MAX_PANEL_WIDTHS.task)).toBe(MAX_PANEL_WIDTHS.task);
  });
});

describe('loadPanelWidth / savePanelWidth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the default when the key is missing', () => {
    expect(loadPanelWidth(PROJECT, 'task')).toBe(DEFAULT_PANEL_WIDTHS.task);
    expect(loadPanelWidth(PROJECT, 'resource')).toBe(DEFAULT_PANEL_WIDTHS.resource);
  });

  it('round-trips a saved width', () => {
    savePanelWidth(PROJECT, 'task', 620);
    expect(loadPanelWidth(PROJECT, 'task')).toBe(620);
  });

  it('clamps an out-of-range persisted value', () => {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ task: 100 }));
    expect(loadPanelWidth(PROJECT, 'task')).toBe(MIN_PANEL_WIDTHS.task);
    localStorage.setItem(PANEL_KEY, JSON.stringify({ task: 9999 }));
    expect(loadPanelWidth(PROJECT, 'task')).toBe(MAX_PANEL_WIDTHS.task);
  });

  it('falls back to the default for corrupt/empty storage', () => {
    localStorage.setItem(PANEL_KEY, 'not-json');
    expect(loadPanelWidth(PROJECT, 'task')).toBe(DEFAULT_PANEL_WIDTHS.task);
    localStorage.setItem(PANEL_KEY, '');
    expect(loadPanelWidth(PROJECT, 'task')).toBe(DEFAULT_PANEL_WIDTHS.task);
  });

  it('keeps task and resource widths independent (merge on save)', () => {
    savePanelWidth(PROJECT, 'task', 600);
    savePanelWidth(PROJECT, 'resource', 520);
    expect(loadPanelWidth(PROJECT, 'task')).toBe(600);
    expect(loadPanelWidth(PROJECT, 'resource')).toBe(520);
  });

  it('isolates widths per project id', () => {
    savePanelWidth(PROJECT, 'task', 600);
    expect(loadPanelWidth('proj-2', 'task')).toBe(DEFAULT_PANEL_WIDTHS.task);
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
    expect(loadColumnWidth(PROJECT, 'task', 'duration')).toBe(DEFAULT_COLUMN_WIDTHS.duration);
    expect(loadColumnWidth(PROJECT, 'resource', 'capacity')).toBe(DEFAULT_COLUMN_WIDTHS.capacity);
  });

  it('round-trips a saved width', () => {
    saveColumnWidth(PROJECT, 'task', 'duration', 120);
    expect(loadColumnWidth(PROJECT, 'task', 'duration')).toBe(120);
  });

  it('clamps an out-of-range persisted value', () => {
    localStorage.setItem(COLUMN_KEY, JSON.stringify({ task: { duration: 10 } }));
    expect(loadColumnWidth(PROJECT, 'task', 'duration')).toBe(40);
  });

  it('falls back to the default for corrupt storage', () => {
    localStorage.setItem(COLUMN_KEY, '{oops');
    expect(loadColumnWidth(PROJECT, 'task', 'duration')).toBe(DEFAULT_COLUMN_WIDTHS.duration);
  });

  it('merges columns and kinds on save', () => {
    saveColumnWidth(PROJECT, 'task', 'duration', 120);
    saveColumnWidth(PROJECT, 'task', 'effort', 80);
    saveColumnWidth(PROJECT, 'resource', 'role', 140);
    expect(loadColumnWidth(PROJECT, 'task', 'duration')).toBe(120);
    expect(loadColumnWidth(PROJECT, 'task', 'effort')).toBe(80);
    expect(loadColumnWidth(PROJECT, 'task', 'progress')).toBe(DEFAULT_COLUMN_WIDTHS.progress);
    expect(loadColumnWidth(PROJECT, 'resource', 'role')).toBe(140);
  });

  afterEach(() => {
    localStorage.clear();
  });
});
