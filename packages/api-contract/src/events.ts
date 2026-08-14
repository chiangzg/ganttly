/**
 * Real-time event contract (spec §11).
 *
 * The server emits change notifications over a single SSE stream
 * (`GET /api/v1/events?workspaceId=…`). Events carry only a *summary* of what
 * changed — never the full project document — so a compromised or stale client
 * cannot reconstruct state from the stream alone. Clients reload the affected
 * project snapshot on demand.
 *
 * `id` is the outbox `sequence` (a global, gap-free bigserial) and doubles as
 * the SSE `Last-Event-ID` resume cursor.
 */

/**
 * Event types emitted in the first version. The stream may also carry the
 * out-of-band {@link ResyncRequiredEvent} (`resync_required`) which is not a
 * project mutation but a client directive.
 */
export const SSE_EVENT_TYPES = [
  'project.created',
  'project.updated',
  'project.archived',
  'project.restored',
  'project.deleted',
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/**
 * The actor that caused an event. `type` mirrors the
 * `project_operations.actor_type` taxonomy (`web` = browser session, `mcp` =
 * PAT-driven MCP tool call, `system` = internal).
 */
export interface EventActor {
  type: 'web' | 'mcp' | 'system';
  id: string;
}

/**
 * A single notification delivered on the SSE stream (spec §11.1). `revision`
 * is the project revision *after* the change (string per the REST contract);
 * absent for events where it is not meaningful.
 */
export interface ProjectEvent {
  /** Outbox sequence — used as the SSE `id`/`Last-Event-ID` cursor. */
  id: number;
  type: SseEventType;
  workspaceId: string;
  projectId?: string;
  revision?: string;
  actor: EventActor;
  operationId?: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** Reasons a client's resume cursor can no longer be honoured. */
export type ResyncReason = 'cursor_expired' | 'gap' | 'over_limit';

/**
 * Out-of-band directive telling the client its `Last-Event-ID` cursor is no
 * longer usable (events were pruned, a gap was detected, or the replay would
 * exceed the cap). The client must re-fetch the project list and the current
 * project snapshot, then continue with a fresh cursor.
 */
export interface ResyncRequiredEvent {
  type: 'resync_required';
  reason: ResyncReason;
}

/**
 * Build a wire-format SSE frame for an event. Pure function so the server
 * route and tests share one source of truth.
 *
 * The frame is `id: <seq>\nevent: <type>\ndata: <json>\n\n`. `data` is the full
 * event object JSON-encoded (spec §11.1 shape).
 */
export function buildSseFrame(event: ProjectEvent): string {
  const lines = [`id: ${event.id}`, `event: ${event.type}`, `data: ${JSON.stringify(event)}`];
  return `${lines.join('\n')}\n\n`;
}

/**
 * Build a frame for a control directive (e.g. `resync_required`). Carries no
 * `id` so it does not advance the resume cursor.
 */
export function buildControlFrame(event: ResyncRequiredEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** SSE heartbeat comment — keeps proxies from timing out an idle stream. */
export const SSE_HEARTBEAT = ': heartbeat\n\n';
