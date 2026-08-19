import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyFile, DEFAULT_VIEW_STATE, type GanttlyFile } from '@ganttly/schema';
import { RemoteRepository } from '@/data/remoteRepository';
import { RevisionConflictError } from '@/data/remoteErrors';
import { saveViewState } from '@/data/viewStateStore';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '@/data/httpClient';

const WS = 'ws_test';
const INSTANCE = 'official';
const USER = 'usr_1';
const PROJECT = 'prj_1';

function makeFile(name = 'Test'): GanttlyFile {
  return createEmptyFile({ name });
}

/** Recording fake — captures the last call and returns a scripted response. */
function makeFakeHttpClient(): HttpClient & {
  calls: Array<{ path: string; options: HttpRequestOptions }>;
  nextResponse: <T>(data: T, revision?: string) => void;
  nextError: (err: Error) => void;
} {
  const calls: Array<{ path: string; options: HttpRequestOptions }> = [];
  let responder:
    ((path: string, options: HttpRequestOptions) => Promise<HttpResponse<unknown>>) | null = null;

  const fake: HttpClient = {
    async request<T>(path: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
      calls.push({ path, options });
      if (!responder) throw new Error('No response scripted');
      return (await responder(path, options)) as HttpResponse<T>;
    },
  };

  return Object.assign(fake, {
    calls,
    nextResponse<T>(data: T, revision?: string) {
      responder = async () => ({
        data,
        etag: revision ? `"${revision}"` : null,
        revision: revision ?? null,
      });
    },
    nextError(err: Error) {
      responder = async () => {
        throw err;
      };
    },
  });
}

function makeRepo(http: HttpClient): RemoteRepository {
  return new RemoteRepository({
    httpClient: http,
    instanceId: INSTANCE,
    workspaceId: WS,
    userId: USER,
  });
}

describe('RemoteRepository', () => {
  let http: ReturnType<typeof makeFakeHttpClient>;
  let repo: RemoteRepository;

  beforeEach(() => {
    localStorage.clear();
    http = makeFakeHttpClient();
    repo = makeRepo(http);
  });

  describe('listProjects', () => {
    it('GETs the project list and unwraps the envelope', async () => {
      http.nextResponse({
        projects: [
          {
            id: 'p1',
            name: 'A',
            createdAt: '',
            updatedAt: '',
            deletedAt: null,
            taskCount: 0,
            completedTaskCount: 0,
            progress: 0,
          },
        ],
      });
      const result = await repo.listProjects();
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('p1');
      expect(http.calls[0]?.path).toBe(`/api/v1/workspaces/${WS}/projects`);
    });

    it('passes deleted + query as query string', async () => {
      http.nextResponse({ projects: [] });
      await repo.listProjects({ includeDeleted: true, query: 'pay' });
      const path = http.calls[0]?.path ?? '';
      expect(path).toContain('deleted=true');
      expect(path).toContain('query=pay');
    });
  });

  describe('loadProject', () => {
    it('merges locally stored viewState onto the server file', async () => {
      const file = makeFile();
      // Store a custom view state for this project.
      saveViewState(
        USER,
        { instanceId: INSTANCE, workspaceId: WS, projectId: PROJECT },
        {
          ...DEFAULT_VIEW_STATE,
          scrollTop: 250,
          zoom: 'day',
        },
      );
      // Server returns a neutral viewState.
      http.nextResponse({
        summary: {
          id: PROJECT,
          name: 'Test',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
        },
        file: { ...file, viewState: { ...DEFAULT_VIEW_STATE } },
        revision: '3',
      });

      const snapshot = await repo.loadProject(PROJECT);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.revision).toBe('3');
      expect(snapshot!.file.viewState.scrollTop).toBe(250);
      expect(snapshot!.file.viewState.zoom).toBe('day');
    });

    it('returns null on 404 NotFound', async () => {
      const { NotFoundError } = await import('@/data/remoteErrors');
      http.nextError(new NotFoundError('NOT_FOUND', 'gone', 404));
      expect(await repo.loadProject('missing')).toBeNull();
    });

    it('rethrows RevisionConflictError', async () => {
      http.nextError(new RevisionConflictError(PROJECT, '1', '2'));
      await expect(repo.loadProject(PROJECT)).rejects.toThrow(RevisionConflictError);
    });
  });

  describe('saveProject', () => {
    it('strips viewState to DEFAULT before PUT and sends If-Match', async () => {
      http.nextResponse({
        summary: {
          id: PROJECT,
          name: 'X',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
        },
        file: makeFile('X'),
        revision: '4',
      });
      const file = makeFile('Edited');
      file.viewState.scrollTop = 999; // client view preference

      await repo.saveProject(PROJECT, file, { expectedRevision: '3' });

      const call = http.calls[0]!;
      expect(call.options.method).toBe('PUT');
      expect(call.options.ifMatch).toBe('3');

      // The fake http client records the body as-is (the real client
      // JSON.stringifies it). Verify the viewState was stripped to default.
      const putBody = call.options.body as { file: GanttlyFile };
      expect(putBody.file.viewState.scrollTop).toBe(0);
      expect(putBody.file.viewState.zoom).toBe(DEFAULT_VIEW_STATE.zoom);
    });

    it('overlays local viewState on the save response', async () => {
      saveViewState(
        USER,
        { instanceId: INSTANCE, workspaceId: WS, projectId: PROJECT },
        {
          ...DEFAULT_VIEW_STATE,
          scrollTop: 42,
        },
      );
      http.nextResponse({
        summary: {
          id: PROJECT,
          name: 'X',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
        },
        file: makeFile('X'),
        revision: '5',
      });
      const snapshot = await repo.saveProject(PROJECT, makeFile(), { expectedRevision: '4' });
      expect(snapshot.file.viewState.scrollTop).toBe(42);
    });

    it('throws RevisionConflictError on 412', async () => {
      http.nextError(new RevisionConflictError(PROJECT, '3', '5'));
      await expect(
        repo.saveProject(PROJECT, makeFile(), { expectedRevision: '3' }),
      ).rejects.toThrow(RevisionConflictError);
    });
  });

  describe('createProject', () => {
    it('POSTs with an idempotency key', async () => {
      http.nextResponse({
        summary: {
          id: 'new',
          name: 'New',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
        },
        file: makeFile('New'),
        revision: '1',
      });
      const snapshot = await repo.createProject({ file: makeFile('New') });
      expect(snapshot.revision).toBe('1');
      const call = http.calls[0]!;
      expect(call.options.method).toBe('POST');
      expect(call.options.idempotencyKey).toBeTruthy();
    });
  });

  describe('archive / restore / delete', () => {
    it('moveToTrash POSTs to archive endpoint', async () => {
      http.nextResponse({
        summary: {
          id: PROJECT,
          name: 'X',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
        },
        file: makeFile(),
        revision: '2',
      });
      await repo.moveToTrash(PROJECT);
      expect(http.calls[0]?.path).toContain('/archive');
      expect(http.calls[0]?.options.method).toBe('POST');
      expect(http.calls[0]?.options.idempotencyKey).toBeTruthy();
    });

    it('restoreProject POSTs to restore endpoint', async () => {
      http.nextResponse({
        summary: {
          id: PROJECT,
          name: 'X',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
        },
        file: makeFile(),
        revision: '2',
      });
      await repo.restoreProject(PROJECT);
      expect(http.calls[0]?.path).toContain('/restore');
      expect(http.calls[0]?.options.method).toBe('POST');
      expect(http.calls[0]?.options.idempotencyKey).toBeTruthy();
    });

    it('deleteProjectPermanently sends DELETE', async () => {
      http.nextResponse(undefined);
      await repo.deleteProjectPermanently(PROJECT);
      expect(http.calls[0]?.options.method).toBe('DELETE');
    });
  });

  describe('deprecated helpers', () => {
    it('load delegates to loadProject and returns file', async () => {
      saveViewState(
        USER,
        { instanceId: INSTANCE, workspaceId: WS, projectId: PROJECT },
        DEFAULT_VIEW_STATE,
      );
      http.nextResponse({
        summary: {
          id: PROJECT,
          name: 'X',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
        },
        file: makeFile('X'),
        revision: '1',
      });
      const file = await repo.load(PROJECT);
      expect(file?.project.name).toBe('X');
    });

    it('deleteProject delegates to moveToTrash', async () => {
      http.nextResponse({
        summary: {
          id: PROJECT,
          name: 'X',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
          taskCount: 0,
          completedTaskCount: 0,
          progress: 0,
        },
        file: makeFile(),
        revision: '1',
      });
      await repo.deleteProject(PROJECT);
      expect(http.calls[0]?.path).toContain('/archive');
    });
  });
});
