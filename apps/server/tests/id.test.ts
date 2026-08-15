import { describe, expect, it } from 'vitest';
import {
  newEventId,
  newOperationId,
  newPersonalAccessTokenId,
  newProjectId,
  newUserId,
  newWorkspaceId,
} from '../src/id';

describe('prefixed ids', () => {
  it.each([
    ['usr_', newUserId],
    ['ws_', newWorkspaceId],
    ['prj_', newProjectId],
    ['op_', newOperationId],
    ['evt_', newEventId],
    ['pat_', newPersonalAccessTokenId],
  ] as const)('emits the %s prefix', (prefix, factory) => {
    const id = factory();
    expect(id.startsWith(prefix)).toBe(true);
    // prefix (incl. its underscore) + 21-char body
    expect(id.length).toBe(prefix.length + 21);
  });

  it('produces unique ids across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(newUserId());
    expect(seen.size).toBe(5000);
  });

  it('uses an unambiguous alphabet (no 0/O/1/I/l)', () => {
    const id = newProjectId();
    const body = id.slice('prj_'.length);
    for (const ch of body) {
      expect('01OIl').not.toContain(ch);
    }
  });
});
