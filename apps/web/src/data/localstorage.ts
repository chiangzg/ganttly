/**
 * LocalStorage-backed `ProjectRepository` — degraded fallback when IndexedDB
 * is unavailable. Same API; smaller capacity (~5MB), synchronous IO.
 *
 * Key format: `ganttly:project:<id>` → JSON-serialized `GanttlyFile`.
 */
import type { GanttlyFile } from '@ganttly/schema';
import type { ProjectMeta, ProjectRepository } from './repository';

const KEY_PREFIX = 'ganttly:project:';

export class LocalStorageRepository implements ProjectRepository {
  async load(id: string): Promise<GanttlyFile | null> {
    const raw = localStorage.getItem(KEY_PREFIX + id);
    if (!raw) return null;
    return JSON.parse(raw) as GanttlyFile;
  }

  async save(id: string, file: GanttlyFile): Promise<void> {
    try {
      localStorage.setItem(KEY_PREFIX + id, JSON.stringify(file));
    } catch (err) {
      // Quota exceeded or private mode — wrap in a friendlier error.
      throw new Error(`无法保存到 LocalStorage(可能空间不足): ${(err as Error).message}`);
    }
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const metas: ProjectMeta[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const file = JSON.parse(raw) as GanttlyFile;
        metas.push({
          id: key.slice(KEY_PREFIX.length),
          name: file.project.name,
          updatedAt: file.meta.updatedAt,
        });
      } catch {
        // skip corrupted entries
      }
    }
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas;
  }

  async deleteProject(id: string): Promise<void> {
    localStorage.removeItem(KEY_PREFIX + id);
  }
}
