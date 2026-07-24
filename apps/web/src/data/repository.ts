import type { GanttlyFile, Task } from '@ganttly/schema';

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
  projectId: ProjectId;
  pinned: boolean;
}

export interface RecentProject {
  projectId: ProjectId;
  lastOpenedAt: string;
}

export interface ProjectNavigationState {
  lastActiveProjectId: ProjectId | null;
  openTabs: OpenProjectTab[];
  favoriteProjectIds: ProjectId[];
  recentProjects: RecentProject[];
}

export const EMPTY_PROJECT_NAVIGATION: ProjectNavigationState = {
  lastActiveProjectId: null,
  openTabs: [],
  favoriteProjectIds: [],
  recentProjects: [],
};

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
