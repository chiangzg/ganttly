/**
 * IndexedDB-backed `ProjectRepository`.
 *
 * Schema: a single object store `projects` keyed by `id`, holding the full
 * `GanttlyFile` document. We deliberately don't normalize tasks/dependencies
 * into separate stores — a project is a single document, which keeps writes
 * atomic and the data model coherent.
 *
 * If IndexedDB is unavailable (private mode,quota), `open()` rejects and the
 * caller falls back to `LocalStorageRepository`.
 */
import type { GanttlyFile } from '@ganttly/schema';
import type { ProjectMeta, ProjectRepository } from './repository';

const DB_NAME = 'ganttly';
const DB_VERSION = 1;
const STORE_NAME = 'projects';

export class IndexedDBRepository implements ProjectRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB not available in this environment'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  async load(id: string): Promise<GanttlyFile | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => {
        const row = req.result as { id: string; file: GanttlyFile } | undefined;
        resolve(row ? row.file : null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async save(id: string, file: GanttlyFile): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ id, file });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const rows = (req.result ?? []) as Array<{
          id: string;
          file: GanttlyFile;
        }>;
        const metas: ProjectMeta[] = rows.map((r) => ({
          id: r.id,
          name: r.file.project.name,
          updatedAt: r.file.meta.updatedAt,
        }));
        metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        resolve(metas);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async deleteProject(id: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
