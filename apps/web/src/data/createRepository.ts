/**
 * Factory that returns the best available `ProjectRepository` for the current
 * environment. Tries IndexedDB first; falls back to LocalStorage.
 *
 * On the server (SSR / Node test env), both are unavailable and we throw —
 * tests should inject a fake repository rather than rely on browser storage.
 */
import type { DataRepository } from './repository';
import { IndexedDBRepository } from './indexeddb';
import { LocalStorageRepository } from './localstorage';

let cached: DataRepository | null = null;

export function getRepository(): DataRepository {
  if (cached) return cached;
  if (typeof indexedDB !== 'undefined') {
    cached = new IndexedDBRepository();
  } else if (typeof localStorage !== 'undefined') {
    cached = new LocalStorageRepository();
  } else {
    throw new Error('No storage backend available (need IndexedDB or localStorage)');
  }
  return cached;
}

/** Test-only: inject a fake repository. */
export function setRepository(repo: DataRepository): void {
  cached = repo;
}
