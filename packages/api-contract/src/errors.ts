/**
 * HTTP API error contract (spec §9.1).
 *
 * Every error response shares the {@link ApiErrorResponse} shape so clients
 * (Web, MCP, external Agents) can switch on `error.code` deterministically.
 * HTTP status mapping lives in {@link errorCodeToStatus} and must stay in sync
 * with the spec.
 */

export const API_VERSION = 'v1' as const;
export const API_PREFIX = `/api/${API_VERSION}` as const;

export const ApiErrorCode = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNSUPPORTED_CLIENT: 'UNSUPPORTED_CLIENT',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** Free-form structured details attached to an error (field paths, hints). */
export type ApiErrorDetails = Record<string, unknown>;

export interface ApiErrorPayload {
  code: ApiErrorCode;
  message: string;
  details?: ApiErrorDetails;
  /** Correlates with the `x-request-id` response header and log line. */
  requestId: string;
}

export interface ApiErrorResponse {
  error: ApiErrorPayload;
}

/**
 * Stable HTTP status mapping (spec §9.1):
 * auth 401 · forbidden 403 · not-found 404 · validation 422 ·
 * idempotency-conflict 409 · revision-conflict 412 · size-limit 413 ·
 * rate-limited 429 · unsupported-client 426.
 */
export const errorCodeToStatus: Record<ApiErrorCode, number> = {
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  IDEMPOTENCY_CONFLICT: 409,
  REVISION_CONFLICT: 412,
  LIMIT_EXCEEDED: 413,
  RATE_LIMITED: 429,
  UNSUPPORTED_CLIENT: 426,
};

/**
 * Build a spec-compliant {@link ApiErrorResponse} body. Callers pass the
 * Fastify `request.id` so the payload matches the response header.
 */
export function buildApiError(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  details?: ApiErrorDetails,
): ApiErrorResponse {
  const payload: ApiErrorPayload = { code, message, requestId };
  if (details !== undefined) payload.details = details;
  return { error: payload };
}
