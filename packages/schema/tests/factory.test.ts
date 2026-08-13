import { describe, expect, it } from 'vitest';
import { createEmptyFile, DEFAULT_VIEW_STATE } from '../src/index.js';

describe('DEFAULT_VIEW_STATE', () => {
  it('matches the canonical neutral remote view state', () => {
    expect(DEFAULT_VIEW_STATE).toEqual({
      zoom: 'week',
      scrollLeft: 0,
      scrollTop: 0,
      selectedTaskId: null,
      showCriticalPath: false,
      collapsedTaskIds: [],
    });
  });
});

describe('createEmptyFile viewState isolation', () => {
  it('returns a fresh viewState copy that does not share the template arrays', () => {
    const file = createEmptyFile({ name: 'x' });
    file.viewState.collapsedTaskIds.push('task_1');
    // Mutating the returned file must not corrupt the shared template.
    expect(DEFAULT_VIEW_STATE.collapsedTaskIds).toEqual([]);
  });
});
