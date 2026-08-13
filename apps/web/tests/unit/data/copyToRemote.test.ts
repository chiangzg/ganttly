import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyFile } from '@ganttly/schema';
import { copyProjectToRemote, prepareRemoteCopy } from '@/data/copyToRemote';
import type { HttpClient, HttpResponse } from '@/data/httpClient';

function makeFakeHttpClient(): HttpClient & {
  calls: Array<{ path: string; method?: string; idempotencyKey?: string }>;
} {
  const calls: Array<{ path: string; method?: string; idempotencyKey?: string }> = [];
  return Object.assign(
    {
      async request<T>(
        path: string,
        options?: { method?: string; idempotencyKey?: string },
      ): Promise<HttpResponse<T>> {
        calls.push({ path, method: options?.method, idempotencyKey: options?.idempotencyKey });
        return {
          data: {
            summary: {
              id: 'prj_new',
              name: 'Copy',
              createdAt: '',
              updatedAt: '',
              deletedAt: null,
              taskCount: 0,
              completedTaskCount: 0,
              progress: 0,
            },
            file: createEmptyFile({ name: 'Copy' }),
            revision: '1',
          } as T,
          etag: '"1"',
          revision: '1',
        };
      },
    },
    { calls },
  );
}

describe('prepareRemoteCopy', () => {
  it('normalises and validates a valid file', () => {
    const file = createEmptyFile({ name: 'Test' });
    const result = prepareRemoteCopy(file);
    expect(result.project.name).toBe('Test');
  });
});

describe('copyProjectToRemote', () => {
  let http: ReturnType<typeof makeFakeHttpClient>;

  beforeEach(() => {
    http = makeFakeHttpClient();
  });

  it('POSTs to the import endpoint with an idempotency key', async () => {
    const ref = await copyProjectToRemote({
      httpClient: http,
      instanceId: 'official',
      workspaceId: 'ws_1',
      name: 'My Copy',
      file: createEmptyFile({ name: 'My Copy' }),
      idempotencyKey: 'key-abc',
    });

    expect(ref).toEqual({ instanceId: 'official', workspaceId: 'ws_1', projectId: 'prj_new' });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.path).toBe('/api/v1/workspaces/ws_1/projects/import');
    expect(http.calls[0]?.method).toBe('POST');
    expect(http.calls[0]?.idempotencyKey).toBe('key-abc');
  });

  it('reuses the same idempotency key on retry', async () => {
    // First call fails (network), second succeeds — both use the same key.
    const failingHttp: HttpClient = {
      async request<T>(): Promise<HttpResponse<T>> {
        throw new Error('network error');
      },
    };

    await expect(
      copyProjectToRemote({
        httpClient: failingHttp,
        instanceId: 'official',
        workspaceId: 'ws_1',
        name: 'Retry',
        file: createEmptyFile(),
        idempotencyKey: 'key-retry',
      }),
    ).rejects.toThrow('network error');

    // Retry with the working http + same key.
    const ref = await copyProjectToRemote({
      httpClient: http,
      instanceId: 'official',
      workspaceId: 'ws_1',
      name: 'Retry',
      file: createEmptyFile(),
      idempotencyKey: 'key-retry',
    });
    expect(ref.projectId).toBe('prj_new');
    expect(http.calls[0]?.idempotencyKey).toBe('key-retry');
  });
});
