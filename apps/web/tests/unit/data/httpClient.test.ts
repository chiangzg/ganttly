import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '@/data/httpClient';
import {
  AuthRequiredError,
  NotFoundError,
  RevisionConflictError,
  ValidationFailedError,
} from '@/data/remoteErrors';

function mockResponse(
  body: unknown,
  init: { status?: number; etag?: string; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Map<string, string>();
  if (init.etag !== undefined) headers.set('etag', init.etag);
  if (init.headers) for (const [k, v] of Object.entries(init.headers)) headers.set(k, v);
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: Object.fromEntries(headers),
  });
}

describe('createHttpClient', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => fetchSpy.mockReset());
  afterEach(() => fetchSpy.mockReset());

  it('sends a GET and returns parsed data + revision from ETag', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ id: 'p1', name: 'Test' }, { etag: '"42"' }));
    const client = createHttpClient('https://example.com/');
    const res = await client.request<{ id: string; name: string }>('/api/v1/foo');
    expect(res.data).toEqual({ id: 'p1', name: 'Test' });
    expect(res.revision).toBe('42');
    expect(res.etag).toBe('"42"');
  });

  it('strips trailing slashes from baseUrl', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ ok: true }));
    const client = createHttpClient('https://example.com///');
    await client.request('/api/v1/foo');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/api/v1/foo',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('serialises body as JSON and sets Content-Type', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ ok: true }));
    const client = createHttpClient('https://example.com');
    await client.request('/api/v1/foo', { method: 'POST', body: { name: 'x' } });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.body).toBe(JSON.stringify({ name: 'x' }));
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sets Idempotency-Key header', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ ok: true }));
    const client = createHttpClient('https://example.com');
    await client.request('/api/v1/foo', { method: 'POST', idempotencyKey: 'key-123' });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('key-123');
  });

  it('sets If-Match header with quoted revision', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ ok: true }));
    const client = createHttpClient('https://example.com');
    await client.request('/api/v1/foo', { method: 'PUT', ifMatch: '5' });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"5"');
  });

  it('uses credentials: include', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ ok: true }));
    const client = createHttpClient('https://example.com');
    await client.request('/api/v1/foo');
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.credentials).toBe('include');
  });

  it('passes AbortSignal through', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ ok: true }));
    const client = createHttpClient('https://example.com');
    const controller = new AbortController();
    await client.request('/api/v1/foo', { signal: controller.signal });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.signal).toBe(controller.signal);
  });

  it('maps 401 to AuthRequiredError', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(
        { error: { code: 'AUTH_REQUIRED', message: 'Login required', requestId: 'r1' } },
        { status: 401 },
      ),
    );
    const client = createHttpClient('https://example.com');
    await expect(client.request('/api/v1/me')).rejects.toThrow(AuthRequiredError);
  });

  it('maps 404 to NotFoundError', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(
        { error: { code: 'NOT_FOUND', message: 'gone', requestId: 'r2' } },
        { status: 404 },
      ),
    );
    const client = createHttpClient('https://example.com');
    await expect(client.request('/api/v1/workspaces/ws/projects/prj_1')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('maps 422 to ValidationFailedError', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(
        { error: { code: 'VALIDATION_FAILED', message: 'bad', requestId: 'r3' } },
        { status: 422 },
      ),
    );
    const client = createHttpClient('https://example.com');
    await expect(client.request('/api/v1/foo')).rejects.toThrow(ValidationFailedError);
  });

  it('maps 412 to RevisionConflictError with actualRevision', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(
        {
          error: {
            code: 'REVISION_CONFLICT',
            message: 'stale',
            requestId: 'r4',
            details: { actualRevision: '7' },
          },
        },
        { status: 412 },
      ),
    );
    const client = createHttpClient('https://example.com');
    try {
      await client.request('/api/v1/workspaces/ws/projects/prj_1');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RevisionConflictError);
      const conflict = err as RevisionConflictError;
      expect(conflict.actualRevision).toBe('7');
      expect(conflict.projectId).toBe('prj_1');
    }
  });

  it('returns undefined data for 204 No Content', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    const client = createHttpClient('https://example.com');
    const res = await client.request<void>('/api/v1/foo', { method: 'DELETE' });
    expect(res.data).toBeUndefined();
  });
});
