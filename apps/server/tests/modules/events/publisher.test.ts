import { describe, expect, it } from 'vitest';
import { mapOutboxRowToEvent } from '../../../src/modules/events/publisher';
import type { OutboxRow } from '../../../src/modules/events/publisher';

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    sequence: 42,
    id: 'evt_1',
    workspaceId: 'ws_1',
    projectId: 'prj_1',
    type: 'project.updated',
    payload: {
      projectId: 'prj_1',
      revision: 43,
      actor: { type: 'mcp', id: 'pat_abc' },
      operationId: 'op_1',
    },
    createdAt: new Date('2026-08-12T10:00:00.000Z'),
    ...over,
  };
}

describe('mapOutboxRowToEvent', () => {
  it('maps sequence→id, coerces revision to string, embeds actor + operationId', () => {
    const e = mapOutboxRowToEvent(row());
    expect(e).toEqual({
      id: 42,
      type: 'project.updated',
      workspaceId: 'ws_1',
      projectId: 'prj_1',
      revision: '43',
      actor: { type: 'mcp', id: 'pat_abc' },
      operationId: 'op_1',
      createdAt: '2026-08-12T10:00:00.000Z',
    });
  });

  it('omits revision/operationId when the payload does not carry them', () => {
    const e = mapOutboxRowToEvent(
      row({
        type: 'project.created',
        payload: { name: 'New project', actor: { type: 'web', id: 'usr_1' } },
      }),
    );
    expect(e.type).toBe('project.created');
    expect(e.revision).toBeUndefined();
    expect(e.operationId).toBeUndefined();
  });

  it('treats a null projectId as undefined', () => {
    const e = mapOutboxRowToEvent(row({ projectId: null }));
    expect(e.projectId).toBeUndefined();
  });

  it('falls back to a system actor when the payload lacks one', () => {
    const e = mapOutboxRowToEvent(row({ payload: { revision: 1 } }));
    expect(e.actor).toEqual({ type: 'system', id: 'unknown' });
  });

  it('preserves an already-string revision', () => {
    const e = mapOutboxRowToEvent(
      row({ payload: { revision: '44', actor: { type: 'web', id: 'u' } } }),
    );
    expect(e.revision).toBe('44');
  });
});
