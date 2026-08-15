/**
 * Server-Sent Events client (spec §11).
 *
 * Wraps the native `EventSource` for the workspace event stream. The browser
 * handles reconnection and `Last-Event-ID` resume automatically: on a transient
 * drop it reconnects and replays missed events from the server's outbox. This
 * module adds typed event dispatch, a `resync_required` hook, a connection
 * state callback, and an injectable `EventSource` constructor so the lifecycle
 * is unit-testable without a network.
 *
 * Same-origin (the official instance) sends the session cookie by default;
 * `withCredentials` is also set so custom cross-origin instances work when the
 * server allows the origin with credentials.
 */
import {
  SSE_EVENT_TYPES,
  type ProjectEvent,
  type ResyncRequiredEvent,
} from '@ganttly/api-contract';

/** Minimal EventSource surface the wrapper depends on (for injection). */
export interface EventSourceLike {
  readonly readyState: 0 | 1 | 2;
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

export type EventSourceCtor = new (
  url: string,
  opts: { withCredentials: boolean },
) => EventSourceLike;

export type StreamState = 'connecting' | 'open' | 'closed';

export interface RemoteEventStreamOptions {
  baseUrl: string;
  workspaceId: string;
  onEvent: (event: ProjectEvent) => void;
  onResync: (event: ResyncRequiredEvent) => void;
  onStateChange?: (state: StreamState) => void;
  /** Injectable EventSource constructor (tests pass a fake). */
  eventSourceCtor?: EventSourceCtor;
}

export interface RemoteEventStream {
  /** The current connection state. */
  readonly state: StreamState;
  /** Tear down the underlying connection. */
  close(): void;
}

const nativeEventSourceCtor: EventSourceCtor | undefined =
  typeof EventSource !== 'undefined' ? (EventSource as unknown as EventSourceCtor) : undefined;

/**
 * Open an SSE stream for a workspace. Returns a handle to close it. If no
 * `EventSource` is available (SSR / unsupported), the stream is a no-op closed
 * stub and `onStateChange` is invoked with `'closed'`.
 */
export function createEventStream(options: RemoteEventStreamOptions): RemoteEventStream {
  const Ctor = options.eventSourceCtor ?? nativeEventSourceCtor;
  let state: StreamState = 'connecting';
  let source: EventSourceLike | null = null;

  const setState = (next: StreamState) => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  if (!Ctor) {
    setState('closed');
    return {
      get state() {
        return state;
      },
      close() {},
    };
  }

  const origin = options.baseUrl.replace(/\/+$/, '');
  const url = `${origin}/api/v1/events?workspaceId=${encodeURIComponent(options.workspaceId)}`;
  const es = new Ctor(url, { withCredentials: true });
  source = es;

  const dispatch = (type: string, data: string): void => {
    if (type === 'resync_required') {
      try {
        options.onResync(JSON.parse(data) as ResyncRequiredEvent);
      } catch {
        /* malformed control frame — ignore */
      }
      return;
    }
    if (!SSE_EVENT_TYPES.includes(type as never)) return;
    try {
      options.onEvent(JSON.parse(data) as ProjectEvent);
    } catch {
      /* malformed event — ignore */
    }
  };

  // Named project events carry their type in the SSE `event:` field, so the
  // browser routes them to dedicated listeners rather than `onmessage`.
  for (const type of [...SSE_EVENT_TYPES, 'resync_required']) {
    es.addEventListener(type, (ev) => dispatch(type, ev.data));
  }

  // EventSource has no per-status error; a drop fires onerror and the browser
  // auto-reconnects. We surface the transition; the hook closes the stream
  // when the active scope/auth changes.
  es.addEventListener('open', () => setState('open'));
  es.addEventListener('error', () => setState('connecting'));

  return {
    get state() {
      return state;
    },
    close() {
      setState('closed');
      source?.close();
      source = null;
    },
  };
}
