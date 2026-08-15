import type { GanttlyFile, Task } from '@ganttly/schema';
import type { ProjectRef } from './projectRef';
import { localRef } from './projectRef';

export type ProjectId = string;
export type ProjectRevision = string;

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  taskCount: number;
  completedTaskCount: number;
  progress: number;
  startDate?: string;
  endDate?: string;
}

/** Backwards-compatible alias used by older callers and tests. */
export type ProjectMeta = ProjectSummary;

export interface ProjectSnapshot {
  summary: ProjectSummary;
  file: GanttlyFile;
  revision: ProjectRevision;
}

export interface ProjectRecord {
  id: ProjectId;
  file: GanttlyFile;
  revision: ProjectRevision;
  deletedAt: string | null;
  summary: ProjectSummary;
}

export interface ListProjectOptions {
  includeDeleted?: boolean;
  query?: string;
}

export interface OpenProjectTab {
  ref: ProjectRef;
  pinned: boolean;
}

export interface RecentProject {
  ref: ProjectRef;
  lastOpenedAt: string;
}

export interface ProjectNavigationState {
  lastActiveRef: ProjectRef | null;
  openTabs: OpenProjectTab[];
  favoriteRefs: ProjectRef[];
  recentProjects: RecentProject[];
}

export const EMPTY_PROJECT_NAVIGATION: ProjectNavigationState = {
  lastActiveRef: null,
  openTabs: [],
  favoriteRefs: [],
  recentProjects: [],
};

/**
 * Migrate a raw persisted navigation blob into the current {@link ProjectRef}-
 * based shape. Handles the pre-PR4 format where ids were bare strings
 * (implicitly local-mode) by wrapping each in a `{ local, local, id }` ref.
 *
 * Also validates the new shape defensively — corrupt arrays / unknown keys
 * are dropped rather than crashing the app.
 */
export function migrateNavigation(raw: unknown): ProjectNavigationState {
  if (!raw || typeof raw !== 'object') return structuredClone(EMPTY_PROJECT_NAVIGATION);
  const obj = raw as Record<string, unknown>;

  // Detect old format: presence of lastActiveProjectId / favoriteProjectIds.
  const isOldFormat =
    'lastActiveProjectId' in obj ||
    'favoriteProjectIds' in obj ||
    (Array.isArray(obj.openTabs) &&
      obj.openTabs.length > 0 &&
      typeof (obj.openTabs as Array<Record<string, unknown>>)[0]?.projectId === 'string');

  if (isOldFormat) {
    return migrateOldNavigation(obj);
  }

  // New format — validate shape.
  const lastActiveRef = parseRef(obj.lastActiveRef);
  const openTabs = Array.isArray(obj.openTabs)
    ? obj.openTabs.map(parseTab).filter((t): t is OpenProjectTab => t !== null)
    : [];
  const favoriteRefs = Array.isArray(obj.favoriteRefs)
    ? obj.favoriteRefs.map(parseRef).filter((r): r is ProjectRef => r !== null)
    : [];
  const recentProjects = Array.isArray(obj.recentProjects)
    ? obj.recentProjects.map(parseRecent).filter((r): r is RecentProject => r !== null)
    : [];

  return { lastActiveRef, openTabs, favoriteRefs, recentProjects };
}

function migrateOldNavigation(obj: Record<string, unknown>): ProjectNavigationState {
  const oldLastActive =
    typeof obj.lastActiveProjectId === 'string' ? obj.lastActiveProjectId : null;
  const oldFavorites = Array.isArray(obj.favoriteProjectIds)
    ? (obj.favoriteProjectIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];
  const oldTabs = Array.isArray(obj.openTabs)
    ? (obj.openTabs as Array<Record<string, unknown>>)
    : [];
  const oldRecents = Array.isArray(obj.recentProjects)
    ? (obj.recentProjects as Array<Record<string, unknown>>)
    : [];

  return {
    lastActiveRef: oldLastActive ? localRef(oldLastActive) : null,
    openTabs: oldTabs
      .filter((tab) => typeof tab.projectId === 'string')
      .map((tab) => ({
        ref: localRef(tab.projectId as string),
        pinned: Boolean(tab.pinned),
      })),
    favoriteRefs: oldFavorites.map((id) => localRef(id)),
    recentProjects: oldRecents
      .filter((r) => typeof r.projectId === 'string')
      .map((r) => ({
        ref: localRef(r.projectId as string),
        lastOpenedAt:
          typeof r.lastOpenedAt === 'string' ? r.lastOpenedAt : new Date(0).toISOString(),
      })),
  };
}

function parseRef(value: unknown): ProjectRef | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.instanceId === 'string' &&
    typeof obj.workspaceId === 'string' &&
    typeof obj.projectId === 'string'
  ) {
    return { instanceId: obj.instanceId, workspaceId: obj.workspaceId, projectId: obj.projectId };
  }
  return null;
}

function parseTab(value: unknown): OpenProjectTab | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const ref = parseRef(obj.ref);
  if (!ref) return null;
  return { ref, pinned: Boolean(obj.pinned) };
}

function parseRecent(value: unknown): RecentProject | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const ref = parseRef(obj.ref);
  if (!ref) return null;
  return {
    ref,
    lastOpenedAt:
      typeof obj.lastOpenedAt === 'string' ? obj.lastOpenedAt : new Date(0).toISOString(),
  };
}

export class RevisionConflictError extends Error {
  constructor(
    public readonly projectId: ProjectId,
    public readonly expectedRevision: ProjectRevision,
    public readonly actualRevision: ProjectRevision,
  ) {
    super(`Project ${projectId} revision conflict`);
    this.name = 'RevisionConflictError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor(public readonly projectId: ProjectId) {
    super(`Project ${projectId} was not found`);
    this.name = 'ProjectNotFoundError';
  }
}

export interface ProjectRepository {
  listProjects(options?: ListProjectOptions): Promise<ProjectSummary[]>;
  loadProject(id: ProjectId): Promise<ProjectSnapshot | null>;
  createProject(input: { id?: ProjectId; file: GanttlyFile }): Promise<ProjectSnapshot>;
  saveProject(
    id: ProjectId,
    file: GanttlyFile,
    options: { expectedRevision: ProjectRevision },
  ): Promise<ProjectSnapshot>;
  moveToTrash(id: ProjectId): Promise<void>;
  restoreProject(id: ProjectId): Promise<void>;
  deleteProjectPermanently(id: ProjectId): Promise<void>;

  /** Deprecated compatibility helpers. */
  load(id: ProjectId): Promise<GanttlyFile | null>;
  save(id: ProjectId, file: GanttlyFile): Promise<void>;
  deleteProject(id: ProjectId): Promise<void>;
}

export interface ProjectPreferencesRepository {
  loadNavigationState(): Promise<ProjectNavigationState>;
  saveNavigationState(state: ProjectNavigationState): Promise<void>;
}

export type DataRepository = ProjectRepository & ProjectPreferencesRepository;

export const DEFAULT_PROJECT_ID = 'default';

/** Compute card metadata without leaking the full project document to list UIs. */
export function summarizeProject(
  id: ProjectId,
  file: GanttlyFile,
  deletedAt: string | null = null,
): ProjectSummary {
  const parentIds = new Set(file.tasks.map((task) => task.parentId).filter(Boolean));
  const leaves = file.tasks.filter((task) => !parentIds.has(task.id));
  const weighted = leaves.reduce(
    (acc, task) => {
      const weight = Math.max(1, task.duration || 1);
      return { weight: acc.weight + weight, progress: acc.progress + task.progress * weight };
    },
    { weight: 0, progress: 0 },
  );
  const dates = collectProjectDates(file.tasks);

  return {
    id,
    name: file.project.name,
    createdAt: file.meta.createdAt,
    updatedAt: file.meta.updatedAt,
    deletedAt,
    taskCount: leaves.length,
    completedTaskCount: leaves.filter((task) => task.progress >= 100).length,
    progress: weighted.weight === 0 ? 0 : Math.round(weighted.progress / weighted.weight),
    ...dates,
  };
}

function collectProjectDates(tasks: Task[]): Pick<ProjectSummary, 'startDate' | 'endDate'> {
  if (tasks.length === 0) return {};
  const starts = tasks
    .map((task) => task.start)
    .filter(Boolean)
    .sort();
  const ends = tasks
    .map((task) => task.end)
    .filter(Boolean)
    .sort();
  return {
    startDate: starts[0],
    endDate: ends[ends.length - 1],
  };
}
