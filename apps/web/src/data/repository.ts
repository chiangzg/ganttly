/**
 * Data-access layer abstraction (PRD §5.3).
 *
 * The UI never touches IndexedDB directly — it goes through `ProjectRepository`.
 * MVP ships an IndexedDB-backed implementation; P1 can swap in a `RemoteRepository`
 * without touching UI code (the React Context injection point is in `DataProvider`).
 */
import type { GanttlyFile } from '@ganttly/schema';

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
}

export interface ProjectRepository {
  /** Load a project by id, or null if not found. */
  load(id: string): Promise<GanttlyFile | null>;
  /** Persist a project (creates or overwrites). */
  save(id: string, file: GanttlyFile): Promise<void>;
  /** List all stored projects (metadata only — for a project picker UI). */
  listProjects(): Promise<ProjectMeta[]>;
  /** Delete a project. No-op if missing. */
  deleteProject(id: string): Promise<void>;
}

export const DEFAULT_PROJECT_ID = 'default';
