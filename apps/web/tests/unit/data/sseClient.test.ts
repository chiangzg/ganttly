import { describe, expect, it } from 'vitest';
import type { ProjectEvent, ResyncRequiredEvent } from '@ganttly/api-contract';
import { createEventStream, type EventSourceLike, type EventSourceCtor } from '@/data/sseClient';

/** A minimal, controllable EventSource double that records the last instance. */
class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource | null = null;
  readonly url: string;
  readonly withCredentials: boolean;
  readyState: 0 | 1 | 2 = 0;
  closed = false;
  private listeners = new Map<string, Array<(ev: { data: string }) => void>>();

  constructor(url: string, opts: { withCredentials: boolean }) {
    this.url = url;
    this.withCredentials = opts.withCredentials;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  /** Test helper: deliver a named frame. */
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  }
  close(): void {
    this.readyState = 2;
    this.closed = true;
  }
}

const fakeCtor: EventSourceCtor = FakeEventSource as unknown as EventSourceCtor;

const sampleEvent: ProjectEvent = {
  id: 9,
  type: 'project.updated',
  workspaceId: 'ws_1',
  projectId: 'prj_1',
  revision: '5',
  actor: { type: 'mcp', id: 'pat_1' },
  operationId: 'op_1',
  createdAt: '2026-08-12T10:00:00.000Z',
};

describe('createEventStream', () => {
  it('connects to the workspace events URL with credentials', () => {
    const stream = createEventStream({
      baseUrl: 'https://srv.example.com/',
      workspaceId: 'ws 1',
      onEvent: () => undefined,
      onResync: () => undefined,
      eventSourceCtor: fakeCtor,
    });
    const src = FakeEventSource.last!;
    // baseUrl trailing slash stripped; workspaceId encoded.
    expect(src.url).toBe('https://srv.example.com/api/v1/events?workspaceId=ws%201');
    expect(src.withCredentials).toBe(true);
    stream.close();
  });

  it('dispatches parsed project events to onEvent', () => {
    const events: ProjectEvent[] = [];
    const stream = createEventStream({
      baseUrl: 'http://localhost',
      workspaceId: 'ws_1',
      onEvent: (e) => events.push(e),
      onResync: () => undefined,
      eventSourceCtor: fakeCtor,
    });
    const src = FakeEventSource.last!;
    src.emit('project.updated', sampleEvent);
    src.emit('project.created', { ...sampleEvent, type: 'project.created' });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(sampleEvent);
    stream.close();
  });

  it('ignores unknown event types and malformed payloads', () => {
    const events: ProjectEvent[] = [];
    const stream = createEventStream({
      baseUrl: 'http://localhost',
      workspaceId: 'ws_1',
      onEvent: (e) => events.push(e),
      onResync: () => undefined,
      eventSourceCtor: fakeCtor,
    });
    const src = FakeEventSource.last!;
    src.emit('something_else', sampleEvent);
    src.emit('project.updated', '{not json');
    expect(events).toHaveLength(0);
    stream.close();
  });

  it('routes resync_required to onResync', () => {
    let resync: ResyncRequiredEvent | null = null;
    const stream = createEventStream({
      baseUrl: 'http://localhost',
      workspaceId: 'ws_1',
      onEvent: () => undefined,
      onResync: (e) => (resync = e),
      eventSourceCtor: fakeCtor,
    });
    FakeEventSource.last!.emit('resync_required', { type: 'resync_required', reason: 'gap' });
    expect(resync).toEqual({ type: 'resync_required', reason: 'gap' });
    stream.close();
  });

  it('reports connection state transitions', () => {
    const states: string[] = [];
    const stream = createEventStream({
      baseUrl: 'http://localhost',
      workspaceId: 'ws_1',
      onEvent: () => undefined,
      onResync: () => undefined,
      onStateChange: (s) => states.push(s),
      eventSourceCtor: fakeCtor,
    });
    const src = FakeEventSource.last!;
    src.emit('open', '');
    src.emit('error', '');
    stream.close();
    expect(states).toEqual(['open', 'connecting', 'closed']);
  });

  it('close() tears down the underlying source', () => {
    const stream = createEventStream({
      baseUrl: 'http://localhost',
      workspaceId: 'ws_1',
      onEvent: () => undefined,
      onResync: () => undefined,
      eventSourceCtor: fakeCtor,
    });
    const src = FakeEventSource.last!;
    stream.close();
    expect(src.closed).toBe(true);
    expect(stream.state).toBe('closed');
  });
});
