import { describe, expect, it } from 'vitest';
import {
  buildControlFrame,
  buildSseFrame,
  SSE_EVENT_TYPES,
  SSE_HEARTBEAT,
  type ProjectEvent,
} from '../src';

const baseEvent: ProjectEvent = {
  id: 42,
  type: 'project.updated',
  workspaceId: 'ws_1',
  projectId: 'prj_1',
  revision: '43',
  actor: { type: 'mcp', id: 'pat_abc' },
  operationId: 'op_1',
  createdAt: '2026-08-12T10:00:00.000Z',
};

describe('SSE_EVENT_TYPES', () => {
  it('lists the four project lifecycle events', () => {
    expect(SSE_EVENT_TYPES).toEqual([
      'project.created',
      'project.updated',
      'project.archived',
      'project.restored',
      'project.deleted',
    ]);
  });
});

describe('buildSseFrame', () => {
  it('emits id/event/data lines terminated by a blank line', () => {
    const frame = buildSseFrame(baseEvent);
    expect(frame).toBe(
      [
        'id: 42',
        'event: project.updated',
        'data: {"id":42,"type":"project.updated","workspaceId":"ws_1","projectId":"prj_1","revision":"43","actor":{"type":"mcp","id":"pat_abc"},"operationId":"op_1","createdAt":"2026-08-12T10:00:00.000Z"}',
        '',
        '',
      ].join('\n'),
    );
  });

  it('uses the event id as the resume cursor', () => {
    const frame = buildSseFrame({ ...baseEvent, id: 7 });
    expect(frame.split('\n')[0]).toBe('id: 7');
  });

  it('omits undefined optional fields from the data payload', () => {
    const frame = buildSseFrame({
      id: 1,
      type: 'project.created',
      workspaceId: 'ws_1',
      actor: { type: 'web', id: 'usr_1' },
      createdAt: '2026-08-12T10:00:00.000Z',
    });
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
    expect(dataLine).not.toContain('projectId');
    expect(dataLine).not.toContain('revision');
    expect(dataLine).not.toContain('operationId');
  });
});

describe('buildControlFrame', () => {
  it('emits a resync_required directive without an id', () => {
    const frame = buildControlFrame({ type: 'resync_required', reason: 'gap' });
    expect(frame).toBe(
      'event: resync_required\ndata: {"type":"resync_required","reason":"gap"}\n\n',
    );
    expect(frame).not.toContain('id:');
  });
});

describe('SSE_HEARTBEAT', () => {
  it('is a comment frame that carries no data', () => {
    expect(SSE_HEARTBEAT).toBe(': heartbeat\n\n');
  });
});
