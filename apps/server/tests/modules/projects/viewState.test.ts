import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_STATE } from '@ganttly/schema';
import { withDefaultViewState } from '../../../src/modules/projects/viewState';
import { createEmptyFile } from '@ganttly/schema';

describe('withDefaultViewState', () => {
  it('replaces the client viewState with the neutral remote default', () => {
    const file = createEmptyFile({ name: 'x' });
    file.viewState = {
      zoom: 'day',
      scrollLeft: 999,
      scrollTop: 888,
      selectedTaskId: 'task_1',
      showCriticalPath: true,
      collapsedTaskIds: ['task_2'],
    };
    const canonical = withDefaultViewState(file);
    expect(canonical.viewState).toEqual(DEFAULT_VIEW_STATE);
  });

  it('does not mutate the input file', () => {
    const file = createEmptyFile({ name: 'x' });
    file.viewState.selectedTaskId = 'task_1';
    withDefaultViewState(file);
    expect(file.viewState.selectedTaskId).toBe('task_1');
  });

  it('returns a viewState whose arrays are not shared with the template', () => {
    const canonical = withDefaultViewState(createEmptyFile({ name: 'x' }));
    canonical.viewState.collapsedTaskIds.push('task_9');
    expect(DEFAULT_VIEW_STATE.collapsedTaskIds).toEqual([]);
  });
});
