/**
 * Typed errors for remote API responses (spec §9.1).
 *
 * The server returns every error as an {@link ApiErrorResponse} with a stable
 * `error.code`. This module maps that wire shape back into structured error
 * classes the web client can `instanceof`-check, so the UI can branch on the
 * failure reason rather than parsing message strings.
 *
 * `RevisionConflictError` is re-exported from `./repository` so there is a
 * single class identity across local and remote repositories — the save
 * pipeline treats both identically.
 */
import {
  type ApiErrorPayload,
  type ApiErrorResponse,
  type ApiErrorCode,
} from '@ganttly/api-contract';
import { RevisionConflictError } from './repository';
import type { ProjectId } from './repository';

export { RevisionConflictError };

/** Base class for all remote API failures. */
export class RemoteError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

export class AuthRequiredError extends RemoteError {
  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, status, requestId, details);
    this.name = 'AuthRequiredError';
  }
}
export class ForbiddenError extends RemoteError {
  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, status, requestId, details);
    this.name = 'ForbiddenError';
  }
}
export class NotFoundError extends RemoteError {
  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, status, requestId, details);
    this.name = 'NotFoundError';
  }
}
export class ValidationFailedError extends RemoteError {
  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, status, requestId, details);
    this.name = 'ValidationFailedError';
  }
}
export class IdempotencyConflictError extends RemoteError {
  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, status, requestId, details);
    this.name = 'IdempotencyConflictError';
  }
}
export class LimitExceededError extends RemoteError {
  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, status, requestId, details);
    this.name = 'LimitExceededError';
  }
}
export class UnsupportedClientError extends RemoteError {
  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, status, requestId, details);
    this.name = 'UnsupportedClientError';
  }
}

const ERROR_CLASSES: Record<ApiErrorCode, typeof RemoteError> = {
  AUTH_REQUIRED: AuthRequiredError,
  FORBIDDEN: ForbiddenError,
  NOT_FOUND: NotFoundError,
  VALIDATION_FAILED: ValidationFailedError,
  IDEMPOTENCY_CONFLICT: IdempotencyConflictError,
  REVISION_CONFLICT: RemoteError, // handled specially below
  LIMIT_EXCEEDED: LimitExceededError,
  RATE_LIMITED: RemoteError,
  UNSUPPORTED_CLIENT: UnsupportedClientError,
  INTERNAL_ERROR: RemoteError,
};

/**
 * Convert a parsed {@link ApiErrorResponse} into the matching typed error.
 * Revision conflicts become a {@link RevisionConflictError} (same class the
 * local repo throws) so the store handles both uniformly.
 */
export function mapApiError(
  payload: ApiErrorPayload,
  status: number,
  projectId?: ProjectId,
): RemoteError | RevisionConflictError {
  if (payload.code === 'REVISION_CONFLICT') {
    const expected = detailsString(payload.details, 'expectedRevision');
    const actual = detailsString(payload.details, 'actualRevision');
    // projectId is unknown for list-level errors; use a placeholder.
    return new RevisionConflictError(projectId ?? '?', expected ?? '?', actual ?? '?');
  }
  const Cls = ERROR_CLASSES[payload.code] ?? RemoteError;
  return new Cls(payload.code, payload.message, status, payload.requestId, payload.details);
}

function detailsString(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/**
 * Parse a fetch response body. If the status is not ok, throw the mapped typed
 * error; otherwise return the parsed JSON. Used by the HTTP client.
 */
export async function parseOrThrow<T>(response: Response, projectId?: ProjectId): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
  if (!response.ok) {
    const payload: ApiErrorPayload = body?.error ?? {
      code: 'VALIDATION_FAILED',
      message: response.statusText || `HTTP ${response.status}`,
      requestId: response.headers.get('x-request-id') ?? 'unknown',
    };
    throw mapApiError(payload, response.status, projectId);
  }
  return body as T;
}
