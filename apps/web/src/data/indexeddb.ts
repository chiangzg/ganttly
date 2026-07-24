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

const DB_NAME = 'ganttly';
const DB_VERSION = 2;
const PROJECT_STORE = 'projects';
const PREFERENCES_STORE = 'preferences';
const NAVIGATION_KEY = 'project-navigation';

type LegacyProjectRow = { id: string; file: GanttlyFile };

export class IndexedDBRepository implements DataRepository {
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
        if (!db.objectStoreNames.contains(PROJECT_STORE)) {
          db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(PREFERENCES_STORE)) {
          db.createObjectStore(PREFERENCES_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  async listProjects(options: ListProjectOptions = {}): Promise<ProjectSummary[]> {
    const db = await this.open();
    const rows = await requestResult<Array<ProjectRecord | LegacyProjectRow>>(
      db.transaction(PROJECT_STORE, 'readonly').objectStore(PROJECT_STORE).getAll(),
    );
    const query = options.query?.trim().toLocaleLowerCase() ?? '';
    return rows
      .map(normalizeRecord)
      .map((row) => row.summary)
      .filter((summary) => options.includeDeleted || !summary.deletedAt)
      .filter((summary) => !query || summary.name.toLocaleLowerCase().includes(query))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async loadProject(id: string): Promise<ProjectSnapshot | null> {
    const db = await this.open();
    const row = await requestResult<ProjectRecord | LegacyProjectRow | undefined>(
      db.transaction(PROJECT_STORE, 'readonly').objectStore(PROJECT_STORE).get(id),
    );
    if (!row) return null;
    const record = normalizeRecord(row);
    return snapshotOf(record);
  }

  async createProject(input: { id?: string; file: GanttlyFile }): Promise<ProjectSnapshot> {
    const id = input.id ?? `prj_${nanoid(12)}`;
    const record = makeRecord(id, input.file, '1', null);
    const db = await this.open();
    await transactionDone(db, PROJECT_STORE, 'readwrite', (store) => store.add(record));
    return snapshotOf(record);
  }

  async saveProject(
    id: string,
    file: GanttlyFile,
    options: { expectedRevision: string },
  ): Promise<ProjectSnapshot> {
    const db = await this.open();
    const transaction = db.transaction(PROJECT_STORE, 'readwrite');
    const store = transaction.objectStore(PROJECT_STORE);
    const existing = await requestResult<ProjectRecord | LegacyProjectRow | undefined>(
      store.get(id),
    );
    if (!existing) {
      transaction.abort();
      throw new ProjectNotFoundError(id);
    }
    const current = normalizeRecord(existing);
    if (current.revision !== options.expectedRevision) {
      transaction.abort();
      throw new RevisionConflictError(id, options.expectedRevision, current.revision);
    }
    const nextRevision = String(Number.parseInt(current.revision, 10) + 1 || 1);
    const record = makeRecord(id, file, nextRevision, current.deletedAt);
    store.put(record);
    await completeTransaction(transaction);
    return snapshotOf(record);
  }

  async moveToTrash(id: string): Promise<void> {
    await this.updateDeletedAt(id, new Date().toISOString());
  }

  async restoreProject(id: string): Promise<void> {
    await this.updateDeletedAt(id, null);
  }

  async deleteProjectPermanently(id: string): Promise<void> {
    const db = await this.open();
    await transactionDone(db, PROJECT_STORE, 'readwrite', (store) => store.delete(id));
  }

  async loadNavigationState(): Promise<ProjectNavigationState> {
    const db = await this.open();
    const row = await requestResult<{ key: string; value: ProjectNavigationState } | undefined>(
      db
        .transaction(PREFERENCES_STORE, 'readonly')
        .objectStore(PREFERENCES_STORE)
        .get(NAVIGATION_KEY),
    );
    return row ? sanitizeNavigation(row.value) : structuredClone(EMPTY_PROJECT_NAVIGATION);
  }

  async saveNavigationState(state: ProjectNavigationState): Promise<void> {
    const db = await this.open();
    await transactionDone(db, PREFERENCES_STORE, 'readwrite', (store) =>
      store.put({ key: NAVIGATION_KEY, value: sanitizeNavigation(state) }),
    );
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

  private async updateDeletedAt(id: string, deletedAt: string | null): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(PROJECT_STORE, 'readwrite');
    const store = transaction.objectStore(PROJECT_STORE);
    const existing = await requestResult<ProjectRecord | LegacyProjectRow | undefined>(
      store.get(id),
    );
    if (!existing) {
      transaction.abort();
      throw new ProjectNotFoundError(id);
    }
    const current = normalizeRecord(existing);
    const record = makeRecord(id, current.file, current.revision, deletedAt);
    store.put(record);
    await completeTransaction(transaction);
  }
}

function normalizeRecord(row: ProjectRecord | LegacyProjectRow): ProjectRecord {
  if ('revision' in row && 'summary' in row) {
    return {
      ...row,
      deletedAt: row.deletedAt ?? null,
      summary: summarizeProject(row.id, row.file, row.deletedAt ?? null),
    };
  }
  return makeRecord(row.id, row.file, '1', null);
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

function sanitizeNavigation(state: ProjectNavigationState): ProjectNavigationState {
  return {
    lastActiveProjectId: state.lastActiveProjectId ?? null,
    openTabs: Array.isArray(state.openTabs) ? state.openTabs : [],
    favoriteProjectIds: Array.isArray(state.favoriteProjectIds) ? state.favoriteProjectIds : [],
    recentProjects: Array.isArray(state.recentProjects) ? state.recentProjects : [],
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function transactionDone(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<void> {
  const transaction = db.transaction(storeName, mode);
  action(transaction.objectStore(storeName));
  await completeTransaction(transaction);
}
