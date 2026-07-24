import type { GanttlyFile } from '@ganttly/schema';
import { nanoid } from 'nanoid';
import {
  EMPTY_PROJECT_NAVIGATION,
  ProjectNotFoundError,
  RevisionConflictError,
  summarizeProject,
  type DataRepository,
  type ListProjectOptions,
  type ProjectNavigationState,
  type ProjectRecord,
  type ProjectSnapshot,
  type ProjectSummary,
} from './repository';

const KEY_PREFIX = 'ganttly:project:';
const NAVIGATION_KEY = 'ganttly:preferences:project-navigation';

export class LocalStorageRepository implements DataRepository {
  async listProjects(options: ListProjectOptions = {}): Promise<ProjectSummary[]> {
    const query = options.query?.trim().toLocaleLowerCase() ?? '';
    const summaries: ProjectSummary[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(KEY_PREFIX)) continue;
      const record = this.readRecord(key.slice(KEY_PREFIX.length));
      if (!record) continue;
      if (!options.includeDeleted && record.deletedAt) continue;
      if (query && !record.summary.name.toLocaleLowerCase().includes(query)) continue;
      summaries.push(record.summary);
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async loadProject(id: string): Promise<ProjectSnapshot | null> {
    const record = this.readRecord(id);
    return record ? snapshotOf(record) : null;
  }

  async createProject(input: { id?: string; file: GanttlyFile }): Promise<ProjectSnapshot> {
    const id = input.id ?? `prj_${nanoid(12)}`;
    if (this.readRecord(id)) throw new Error(`Project ${id} already exists`);
    const record = makeRecord(id, input.file, '1', null);
    this.writeRecord(record);
    return snapshotOf(record);
  }

  async saveProject(
    id: string,
    file: GanttlyFile,
    options: { expectedRevision: string },
  ): Promise<ProjectSnapshot> {
    const current = this.readRecord(id);
    if (!current) throw new ProjectNotFoundError(id);
    if (current.revision !== options.expectedRevision) {
      throw new RevisionConflictError(id, options.expectedRevision, current.revision);
    }
    const revision = String(Number.parseInt(current.revision, 10) + 1 || 1);
    const record = makeRecord(id, file, revision, current.deletedAt);
    this.writeRecord(record);
    return snapshotOf(record);
  }

  async moveToTrash(id: string): Promise<void> {
    this.updateDeletedAt(id, new Date().toISOString());
  }

  async restoreProject(id: string): Promise<void> {
    this.updateDeletedAt(id, null);
  }

  async deleteProjectPermanently(id: string): Promise<void> {
    localStorage.removeItem(KEY_PREFIX + id);
  }

  async loadNavigationState(): Promise<ProjectNavigationState> {
    const raw = localStorage.getItem(NAVIGATION_KEY);
    if (!raw) return structuredClone(EMPTY_PROJECT_NAVIGATION);
    try {
      const state = JSON.parse(raw) as ProjectNavigationState;
      return {
        lastActiveProjectId: state.lastActiveProjectId ?? null,
        openTabs: Array.isArray(state.openTabs) ? state.openTabs : [],
        favoriteProjectIds: Array.isArray(state.favoriteProjectIds) ? state.favoriteProjectIds : [],
        recentProjects: Array.isArray(state.recentProjects) ? state.recentProjects : [],
      };
    } catch {
      return structuredClone(EMPTY_PROJECT_NAVIGATION);
    }
  }

  async saveNavigationState(state: ProjectNavigationState): Promise<void> {
    localStorage.setItem(NAVIGATION_KEY, JSON.stringify(state));
  }

  // Compatibility API ------------------------------------------------------

  async load(id: string): Promise<GanttlyFile | null> {
    return (await this.loadProject(id))?.file ?? null;
  }

  async save(id: string, file: GanttlyFile): Promise<void> {
    const current = await this.loadProject(id);
    if (current) await this.saveProject(id, file, { expectedRevision: current.revision });
    else await this.createProject({ id, file });
  }

  async deleteProject(id: string): Promise<void> {
    await this.deleteProjectPermanently(id);
  }

  private readRecord(id: string): ProjectRecord | null {
    const raw = localStorage.getItem(KEY_PREFIX + id);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ProjectRecord | GanttlyFile;
      if ('file' in parsed && 'revision' in parsed) {
        return makeRecord(id, parsed.file, parsed.revision, parsed.deletedAt ?? null);
      }
      if ('schemaVersion' in parsed) return makeRecord(id, parsed, '1', null);
      return null;
    } catch {
      return null;
    }
  }

  private writeRecord(record: ProjectRecord): void {
    try {
      localStorage.setItem(KEY_PREFIX + record.id, JSON.stringify(record));
    } catch (error) {
      throw new Error(`无法保存到 LocalStorage(可能空间不足): ${(error as Error).message}`);
    }
  }

  private updateDeletedAt(id: string, deletedAt: string | null): void {
    const current = this.readRecord(id);
    if (!current) throw new ProjectNotFoundError(id);
    this.writeRecord(makeRecord(id, current.file, current.revision, deletedAt));
  }
}

function makeRecord(
  id: string,
  file: GanttlyFile,
  revision: string,
  deletedAt: string | null,
): ProjectRecord {
  return { id, file, revision, deletedAt, summary: summarizeProject(id, file, deletedAt) };
}

function snapshotOf(record: ProjectRecord): ProjectSnapshot {
  return { file: record.file, revision: record.revision, summary: record.summary };
}
