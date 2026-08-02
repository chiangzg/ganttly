import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAWER_WIDTH,
  MIN_DRAWER_WIDTH,
  MAX_DRAWER_WIDTH,
  clampDrawerWidth,
  loadDrawerWidth,
  saveDrawerWidth,
} from '@/lib/drawerWidthPrefs';
import { useViewStore } from '@/store/useViewStore';

const STORAGE_KEY = 'ganttly:preferences:drawer-width';

describe('clampDrawerWidth', () => {
  it('returns the default for non-finite values', () => {
    expect(clampDrawerWidth(NaN)).toBe(DEFAULT_DRAWER_WIDTH);
    expect(clampDrawerWidth(Infinity)).toBe(DEFAULT_DRAWER_WIDTH);
  });

  it('clamps below the minimum to MIN', () => {
    expect(clampDrawerWidth(0)).toBe(MIN_DRAWER_WIDTH);
    expect(clampDrawerWidth(100)).toBe(MIN_DRAWER_WIDTH);
    expect(clampDrawerWidth(MIN_DRAWER_WIDTH - 1)).toBe(MIN_DRAWER_WIDTH);
  });

  it('clamps above the maximum to MAX', () => {
    expect(clampDrawerWidth(9999)).toBe(MAX_DRAWER_WIDTH);
    expect(clampDrawerWidth(MAX_DRAWER_WIDTH + 1)).toBe(MAX_DRAWER_WIDTH);
  });

  it('passes through in-range values (rounded)', () => {
    expect(clampDrawerWidth(360)).toBe(360);
    expect(clampDrawerWidth(400)).toBe(400);
    // Fractions are rounded to the nearest integer.
    expect(clampDrawerWidth(359.7)).toBe(360);
  });

  it('keeps boundary values inclusive', () => {
    expect(clampDrawerWidth(MIN_DRAWER_WIDTH)).toBe(MIN_DRAWER_WIDTH);
    expect(clampDrawerWidth(MAX_DRAWER_WIDTH)).toBe(MAX_DRAWER_WIDTH);
  });
});

describe('loadDrawerWidth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the default when the key is missing', () => {
    expect(loadDrawerWidth()).toBe(DEFAULT_DRAWER_WIDTH);
  });

  it('returns a valid persisted value', () => {
    localStorage.setItem(STORAGE_KEY, '420');
    expect(loadDrawerWidth()).toBe(420);
  });

  it('clamps an out-of-range persisted value', () => {
    localStorage.setItem(STORAGE_KEY, '100');
    expect(loadDrawerWidth()).toBe(MIN_DRAWER_WIDTH);
    localStorage.setItem(STORAGE_KEY, '9999');
    expect(loadDrawerWidth()).toBe(MAX_DRAWER_WIDTH);
  });

  it('falls back to the default for a non-numeric value', () => {
    localStorage.setItem(STORAGE_KEY, 'wide');
    expect(loadDrawerWidth()).toBe(DEFAULT_DRAWER_WIDTH);
  });

  it('falls back to the default for an empty string', () => {
    localStorage.setItem(STORAGE_KEY, '');
    expect(loadDrawerWidth()).toBe(DEFAULT_DRAWER_WIDTH);
  });
});

describe('saveDrawerWidth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists a clamped width', () => {
    saveDrawerWidth(380);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('380');
  });

  it('clamps before persisting', () => {
    saveDrawerWidth(100);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(MIN_DRAWER_WIDTH));
    saveDrawerWidth(9999);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(MAX_DRAWER_WIDTH));
  });

  it('rounds fractions before persisting', () => {
    saveDrawerWidth(359.6);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('360');
  });
});

describe('drawerWidth round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('save then load returns the same in-range value', () => {
    saveDrawerWidth(440);
    expect(loadDrawerWidth()).toBe(440);
  });

  afterEach(() => {
    localStorage.clear();
  });
});

describe('store setDrawerWidth', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the store to its initial (default) width so tests are independent.
    useViewStore.setState({ drawerWidth: DEFAULT_DRAWER_WIDTH });
  });

  it('clamps and persists on set', () => {
    useViewStore.getState().setDrawerWidth(100);
    expect(useViewStore.getState().drawerWidth).toBe(MIN_DRAWER_WIDTH);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(MIN_DRAWER_WIDTH));
  });

  it('updates the store width in-range', () => {
    useViewStore.getState().setDrawerWidth(420);
    expect(useViewStore.getState().drawerWidth).toBe(420);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('420');
  });
});
