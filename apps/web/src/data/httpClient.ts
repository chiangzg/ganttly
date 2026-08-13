/**
 * Thin fetch wrapper for the ganttly REST API (spec §9).
 *
 * One client per remote instance, bound to a `baseUrl` at construction. All
 * requests carry `credentials: 'include'` so the HttpOnly session cookie flows
 * automatically — no token is ever held in JavaScript (spec §2.3).
 *
 * Non-2xx responses are mapped to typed errors via {@link parseOrThrow}. The
 * `ETag` response header (spec §5.2 — `"<revision>"`) is surfaced as a
 * `revision` string so callers don't repeat the quote-stripping logic.
 */
import { parseOrThrow } from './remoteErrors';
import type { ProjectId } from './repository';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Extra headers beyond the defaults. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Sets the `Idempotency-Key` header for non-idempotent POSTs (spec §9.3). */
  idempotencyKey?: string;
  /** Sets the `If-Match` header for optimistic-concurrency PUTs. */
  ifMatch?: string;
}

export interface HttpResponse<T> {
  data: T;
  /** Raw ETag header value (including quotes), or null if absent. */
  etag: string | null;
  /** Revision extracted from the ETag (quotes stripped), or null. */
  revision: string | null;
}

export interface HttpClient {
  request<T>(path: string, options?: HttpRequestOptions): Promise<HttpResponse<T>>;
}

export function createHttpClient(baseUrl: string): HttpClient {
  const origin = baseUrl.replace(/\/+$/, '');
  return {
    async request<T>(path: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
      const url = `${origin}${path}`;
      const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
      let body: BodyInit | undefined;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
      if (options.ifMatch) headers['If-Match'] = `"${options.ifMatch}"`;

      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        credentials: 'include',
        signal: options.signal,
      });
      const projectId = extractProjectId(path);
      const data = await parseOrThrow<T>(response, projectId);
      const etag = response.headers.get('etag');
      const revision = etag ? etag.replace(/^"|"$/g, '') : null;
      return { data, etag, revision };
    },
  };
}

/**
 * Best-effort extraction of the projectId from a REST path, used only to tag
 * {@link RevisionConflictError} instances with a useful identifier. Paths look
 * like `/api/v1/workspaces/ws_x/projects/prj_y`; the project id is the segment
 * after `projects/` when present.
 */
function extractProjectId(path: string): ProjectId | undefined {
  const idx = path.indexOf('/projects/');
  if (idx < 0) return undefined;
  const tail = path.slice(idx + '/projects/'.length);
  const nextSlash = tail.indexOf('/');
  return nextSlash < 0 ? tail : tail.slice(0, nextSlash);
}
