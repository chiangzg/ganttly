import { describe, expect, it } from 'vitest';
import { computeAssigneeSummary, resolveAssignees } from '../src/assigneeSummary';
import type { Resource, TaskAssignment } from '@ganttly/schema';

function mkResource(id: string, name: string): Resource {
  return { id, name };
}
function mkAssignment(resourceId: string, load: number): TaskAssignment {
  return { resourceId, load };
}

describe('resolveAssignees', () => {
  it('returns [] for a task with no assignments', () => {
    expect(resolveAssignees([], new Map())).toEqual([]);
  });

  it('resolves a single assignment to its resource name + load', () => {
    const map = new Map([['r1', mkResource('r1', '王强')]]);
    expect(resolveAssignees([mkAssignment('r1', 80)], map)).toEqual([
      { id: 'r1', name: '王强', load: 80 },
    ]);
  });

  it('resolves multiple assignments in array order', () => {
    const map = new Map([
      ['r1', mkResource('r1', '王强')],
      ['r2', mkResource('r2', '李雷')],
      ['r3', mkResource('r3', '韩梅梅')],
    ]);
    expect(
      resolveAssignees(
        [mkAssignment('r1', 50), mkAssignment('r2', 30), mkAssignment('r3', 100)],
        map,
      ),
    ).toEqual([
      { id: 'r1', name: '王强', load: 50 },
      { id: 'r2', name: '李雷', load: 30 },
      { id: 'r3', name: '韩梅梅', load: 100 },
    ]);
  });

  it('drops assignments whose resource was deleted (id not in map)', () => {
    const map = new Map([['r1', mkResource('r1', '王强')]]);
    const out = resolveAssignees([mkAssignment('r1', 50), mkAssignment('ghost', 50)], map);
    expect(out).toEqual([{ id: 'r1', name: '王强', load: 50 }]);
  });

  it('drops everything when the resource is fully deleted', () => {
    expect(resolveAssignees([mkAssignment('ghost', 100)], new Map())).toEqual([]);
  });
});

describe('computeAssigneeSummary', () => {
  it('returns "" for no assignees (caller shows muted "未分配")', () => {
    expect(computeAssigneeSummary([])).toBe('');
  });

  it('returns the single owner name for one assignee', () => {
    expect(computeAssigneeSummary([{ id: 'r1', name: '王强', load: 100 }])).toBe('王强');
  });

  it('returns "primary +N" for multiple assignees', () => {
    expect(
      computeAssigneeSummary([
        { id: 'r1', name: '王强', load: 50 },
        { id: 'r2', name: '李雷', load: 30 },
        { id: 'r3', name: '韩梅梅', load: 100 },
      ]),
    ).toBe('王强 +2');
  });

  it('counts exactly: two assignees → "primary +1"', () => {
    expect(
      computeAssigneeSummary([
        { id: 'r1', name: 'Alice', load: 50 },
        { id: 'r2', name: 'Bob', load: 50 },
      ]),
    ).toBe('Alice +1');
  });

  it('uses the FIRST assignee as primary regardless of load', () => {
    expect(
      computeAssigneeSummary([
        { id: 'r1', name: 'LowLoad', load: 10 },
        { id: 'r2', name: 'HighLoad', load: 200 },
      ]),
    ).toBe('LowLoad +1');
  });
});
