/**
 * Domain error → HTTP response bridge.
 *
 * Service code and helpers throw {@link HttpError} carrying an
 * {@link ApiErrorCode}; the Fastify error handler in `bootstrap.ts` maps each
 * to its status and the shared {@link ApiErrorResponse} body. Routes never
 * assemble error responses themselves.
 */
import { type ApiErrorCode, type ApiErrorDetails } from '@ganttly/api-contract';

export class HttpError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
