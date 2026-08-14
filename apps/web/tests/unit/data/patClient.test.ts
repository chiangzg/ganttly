import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, ValidationFailedError } from '@/data/remoteErrors';
import { createPat, listPats, resetPatClient, revokePat } from '@/data/patClient';

function mockResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('patClient', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    fetchSpy.mockReset();
    resetPatClient();
  });
  afterEach(() => fetchSpy.mockReset());

  it('createPat POSTs to /me/tokens and returns the token + summary', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        token: 'pat_secret123',
        pat: {
          id: 'pat_1',
          name: 'CI',
          tokenPrefix: 'pat_secret',
          scopes: ['task:write'],
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    );
    const result = await createPat({ name: 'CI', scopes: ['task:write'] });
    expect(result.token).toBe('pat_secret123');
    expect(result.pat.name).toBe('CI');
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toContain('/api/v1/me/tokens');
    const opts = call[1] as RequestInit;
    expect(opts.method).toBe('POST');
    expect(opts.credentials).toBe('include');
  });

  it('listPats unwraps the { tokens } envelope', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        tokens: [
          {
            id: 'pat_1',
            name: 'A',
            tokenPrefix: 'pat_a',
            scopes: ['project:read'],
            expiresAt: null,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    const tokens = await listPats();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.name).toBe('A');
  });

  it('revokePat DELETEs and resolves on 204', async () => {
    fetchSpy.mockResolvedValue(mockResponse(null, { status: 204 }));
    await expect(revokePat('pat_1')).resolves.toBeUndefined();
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toContain('/api/v1/me/tokens/pat_1');
    expect((call[1] as RequestInit).method).toBe('DELETE');
  });

  it('maps a 401 to AuthRequiredError', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(
        { error: { code: 'AUTH_REQUIRED', message: 'no session', requestId: 'r1' } },
        { status: 401 },
      ),
    );
    await expect(listPats()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('maps a 422 to ValidationFailedError', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(
        { error: { code: 'VALIDATION_FAILED', message: 'bad scope', requestId: 'r1' } },
        { status: 422 },
      ),
    );
    await expect(createPat({ name: 'x', scopes: ['bogus:scope' as never] })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});
