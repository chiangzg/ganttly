/**
 * HTTP-backed {@link ProjectRepository} for a single remote workspace
 * (spec §12.4).
 *
 * Bound at construction to one `(instance, workspace, user)` triple. Every
 * method maps to a REST call under `/api/v1/workspaces/:workspaceId/projects`.
 * The session cookie travels automatically via `credentials: 'include'`.
 *
 * **viewState separation (spec §5.2):** the server stores a neutral
 * `DEFAULT_VIEW_STATE` and ignores the client viewState. On load we overlay
 * the per-device view state from {@link viewStateStore}; on save we strip it
 * back to the default so the PUT body never carries local view preferences.
 *
 * **Error mapping (spec §12.4):** 401/403/404/422/412 etc. become typed
 * {@link RemoteError} subclasses. A 412 `REVISION_CONFLICT` becomes the same
 * {@link RevisionConflictError} the local repository throws, so the store's
 * conflict handling is uniform.
 *
 * Navigation-state persistence (`loadNavigationState`/`saveNavigationState`)
 * is intentionally NOT implemented here — navigation always stays local.
 */
import { DEFAULT_VIEW_STATE, type GanttlyFile } from '@ganttly/schema';
import type { ProjectSnapshotResponse } from '@ganttly/api-contract';
import type { HttpClient } from './httpClient';
import { NotFoundError, RevisionConflictError } from './remoteErrors';
import { loadViewState } from './viewStateStore';
import type { ProjectRef } from './projectRef';
import type {
  ListProjectOptions,
  ProjectId,
  ProjectRepository,
  ProjectSnapshot,
  ProjectSummary,
} from './repository';

export interface RemoteRepositoryOptions {
  httpClient: HttpClient;
  instanceId: string;
  workspaceId: string;
  /** Authenticated user id — keys the per-device viewState cache. */
  userId: string;
}

interface ProjectsListResponse {
  projects: ProjectSummary[];
}

function projectsPath(workspaceId: string): string {
  return `/api/v1/workspaces/${workspaceId}/projects`;
}

function projectPath(workspaceId: string, projectId: string): string {
  return `${projectsPath(workspaceId)}/${projectId}`;
}

export class RemoteRepository implements ProjectRepository {
  constructor(private readonly options: RemoteRepositoryOptions) {}

  private get http(): HttpClient {
    return this.options.httpClient;
  }

  private get ws(): string {
    return this.options.workspaceId;
  }

  // --- ProjectRepository ----------------------------------------------------

  async listProjects(options: ListProjectOptions = {}): Promise<ProjectSummary[]> {
    const params = new URLSearchParams();
    if (options.includeDeleted) params.set('deleted', 'true');
    if (options.query) params.set('query', options.query);
    const qs = params.toString();
    const path = qs ? `${projectsPath(this.ws)}?${qs}` : projectsPath(this.ws);
    const { data } = await this.http.request<ProjectsListResponse>(path);
    return data.projects;
  }

  async loadProject(id: ProjectId): Promise<ProjectSnapshot | null> {
    try {
      const { data } = await this.http.request<ProjectSnapshotResponse>(projectPath(this.ws, id));
      return this.mergeViewState(data, id);
    } catch (err) {
      if (err instanceof RevisionConflictError) throw err;
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async createProject(input: { id?: ProjectId; file: GanttlyFile }): Promise<ProjectSnapshot> {
    const { data } = await this.http.request<ProjectSnapshotResponse>(projectsPath(this.ws), {
      method: 'POST',
      body: { file: input.file },
      idempotencyKey: cryptoIdempotencyKey(),
    });
    return { summary: data.summary, file: data.file, revision: data.revision };
  }

  async saveProject(
    id: ProjectId,
    file: GanttlyFile,
    options: { expectedRevision: string },
  ): Promise<ProjectSnapshot> {
    // Strip the client viewState — the server ignores it anyway and we don't
    // want local view preferences leaking into the revision (spec §5.2).
    const stripped: GanttlyFile = {
      ...file,
      viewState: {
        ...DEFAULT_VIEW_STATE,
        collapsedTaskIds: [...DEFAULT_VIEW_STATE.collapsedTaskIds],
      },
    };
    const { data } = await this.http.request<ProjectSnapshotResponse>(projectPath(this.ws, id), {
      method: 'PUT',
      body: { file: stripped },
      ifMatch: options.expectedRevision,
    });
    return this.mergeViewState(data, id);
  }

  async moveToTrash(id: ProjectId): Promise<void> {
    await this.http.request<ProjectSnapshotResponse>(`${projectPath(this.ws, id)}/archive`, {
      method: 'POST',
    });
  }

  async restoreProject(id: ProjectId): Promise<void> {
    await this.http.request<ProjectSnapshotResponse>(`${projectPath(this.ws, id)}/restore`, {
      method: 'POST',
    });
  }

  async deleteProjectPermanently(id: ProjectId): Promise<void> {
    await this.http.request<void>(projectPath(this.ws, id), { method: 'DELETE' });
  }

  // --- Deprecated compatibility helpers -------------------------------------

  async load(id: ProjectId): Promise<GanttlyFile | null> {
    const snapshot = await this.loadProject(id);
    return snapshot?.file ?? null;
  }

  async save(id: ProjectId, file: GanttlyFile): Promise<void> {
    // Deprecated path with no revision — load current then save.
    const existing = await this.loadProject(id);
    await this.saveProject(id, file, {
      expectedRevision: existing?.revision ?? '0',
    });
  }

  async deleteProject(id: ProjectId): Promise<void> {
    await this.moveToTrash(id);
  }

  // --- Internal -------------------------------------------------------------

  /**
   * Overlay the per-device viewState onto a server snapshot (spec §5.2 rule
   * 3). The server's neutral viewState is replaced entirely so zoom/scroll/
   * selection survive across reloads without advancing the revision.
   */
  private mergeViewState(data: ProjectSnapshotResponse, id: ProjectId): ProjectSnapshot {
    const ref: ProjectRef = {
      instanceId: this.options.instanceId,
      workspaceId: this.ws,
      projectId: id,
    };
    const viewState = loadViewState(this.options.userId, ref);
    return {
      summary: data.summary,
      file: { ...data.file, viewState },
      revision: data.revision,
    };
  }
}

/**
 * Generate an idempotency key for a create POST. Uses crypto.randomUUID when
 * available (browsers), falls back to a timestamp+random string.
 */
function cryptoIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
