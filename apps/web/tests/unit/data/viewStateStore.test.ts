import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_STATE } from '@ganttly/schema';
import { clearViewState, loadViewState, saveViewState } from '@/data/viewStateStore';
import type { ProjectRef } from '@/data/projectRef';

const USER = 'usr_abc';
const ref: ProjectRef = { instanceId: 'official', workspaceId: 'ws_1', projectId: 'prj_1' };

describe('viewStateStore', () => {
  beforeEach(() => localStorage.clear());

  it('returns DEFAULT_VIEW_STATE when nothing is stored', () => {
    const vs = loadViewState(USER, ref);
    expect(vs).toEqual(DEFAULT_VIEW_STATE);
    // Must be a fresh copy, not the shared template reference.
    expect(vs).not.toBe(DEFAULT_VIEW_STATE);
    expect(vs.collapsedTaskIds).not.toBe(DEFAULT_VIEW_STATE.collapsedTaskIds);
  });

  it('round-trips a view state', () => {
    const custom = { ...DEFAULT_VIEW_STATE, zoom: 'day' as const, scrollTop: 999 };
    saveViewState(USER, ref, custom);
    expect(loadViewState(USER, ref).scrollTop).toBe(999);
    expect(loadViewState(USER, ref).zoom).toBe('day');
  });

  it('keys by userId so different users do not collide', () => {
    saveViewState(USER, ref, { ...DEFAULT_VIEW_STATE, scrollTop: 100 });
    saveViewState('usr_other', ref, { ...DEFAULT_VIEW_STATE, scrollTop: 200 });
    expect(loadViewState(USER, ref).scrollTop).toBe(100);
    expect(loadViewState('usr_other', ref).scrollTop).toBe(200);
  });

  it('keys by ref so different projects do not collide', () => {
    const ref2 = { ...ref, projectId: 'prj_2' };
    saveViewState(USER, ref, { ...DEFAULT_VIEW_STATE, scrollTop: 50 });
    saveViewState(USER, ref2, { ...DEFAULT_VIEW_STATE, scrollTop: 75 });
    expect(loadViewState(USER, ref).scrollTop).toBe(50);
    expect(loadViewState(USER, ref2).scrollTop).toBe(75);
  });

  it('clearViewState removes the entry', () => {
    saveViewState(USER, ref, { ...DEFAULT_VIEW_STATE, scrollTop: 42 });
    clearViewState(USER, ref);
    expect(loadViewState(USER, ref).scrollTop).toBe(0);
  });

  it('merges partial stored state with defaults', () => {
    // Simulate an older entry that lacks newer fields.
    const key = `ganttly:view-state:${USER}:${ref.instanceId}/${ref.workspaceId}/${ref.projectId}`;
    localStorage.setItem(key, JSON.stringify({ scrollTop: 5 }));
    const vs = loadViewState(USER, ref);
    expect(vs.scrollTop).toBe(5);
    expect(vs.zoom).toBe(DEFAULT_VIEW_STATE.zoom);
    expect(Array.isArray(vs.collapsedTaskIds)).toBe(true);
  });
});
