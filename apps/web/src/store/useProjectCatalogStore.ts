import { create } from 'zustand';
import { createEmptyFile, normalizeFile, type GanttlyFile, type Holiday } from '@ganttly/schema';
import { getCalendar } from '@ganttly/calendar-data';
import {
  EMPTY_PROJECT_NAVIGATION,
  type DataRepository,
  type ProjectId,
  type ProjectNavigationState,
  type ProjectSummary,
} from '@/data/repository';
import { useProjectStore } from './useProjectStore';
import { useViewStore } from './useViewStore';

type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ProjectCatalogState {
  repo: DataRepository | null;
  projects: ProjectSummary[];
  trash: ProjectSummary[];
  navigation: ProjectNavigationState;
  status: CatalogStatus;
  error: string | null;
  preferenceError: string | null;

  init(repo: DataRepository): Promise<void>;
  refresh(): Promise<void>;
  activateProject(id: ProjectId): Promise<boolean>;
  createProject(name: string, source?: GanttlyFile): Promise<ProjectId>;
  renameProject(id: ProjectId, name: string): Promise<void>;
  duplicateProject(id: ProjectId): Promise<ProjectId>;
  moveToTrash(id: ProjectId): Promise<ProjectId | null>;
  restoreProject(id: ProjectId): Promise<void>;
  deleteProjectPermanently(id: ProjectId): Promise<void>;
  toggleFavorite(id: ProjectId): void;
  togglePinned(id: ProjectId): void;
  closeTab(id: ProjectId): ProjectId | null;
  moveTab(id: ProjectId, direction: -1 | 1): void;
  reorderTab(sourceId: ProjectId, targetId: ProjectId): void;
}

const getHolidays = (region: string): Holiday[] => getCalendar(region).holidays;

export const useProjectCatalogStore = create<ProjectCatalogState>((set, get) => ({
  repo: null,
  projects: [],
  trash: [],
  navigation: structuredClone(EMPTY_PROJECT_NAVIGATION),
  status: 'idle',
  error: null,
  preferenceError: null,

  async init(repo) {
    set({ repo, status: 'loading', error: null });
    useProjectStore.getState().setRepository(repo);
    try {
      const [summaries, savedNavigation] = await Promise.all([
        repo.listProjects({ includeDeleted: true }),
        repo.loadNavigationState(),
      ]);
      const projects = summaries.filter((project) => !project.deletedAt);
      const trash = summaries.filter((project) => Boolean(project.deletedAt));
      const navigation = sanitizeNavigation(savedNavigation, projects);
      set({ projects, trash, navigation, status: 'ready' });
      if (JSON.stringify(navigation) !== JSON.stringify(savedNavigation)) {
        await persistNavigation(repo, navigation, set);
      }
    } catch (error) {
      set({ status: 'error', error: (error as Error).message });
    }
  },

  async refresh() {
    const { repo } = get();
    if (!repo) return;
    try {
      const summaries = await repo.listProjects({ includeDeleted: true });
      const projects = summaries.filter((project) => !project.deletedAt);
      const trash = summaries.filter((project) => Boolean(project.deletedAt));
      const navigation = sanitizeNavigation(get().navigation, projects);
      set({ projects, trash, navigation, status: 'ready', error: null });
      await persistNavigation(repo, navigation, set);
    } catch (error) {
      set({ status: 'error', error: (error as Error).message });
    }
  },

  async activateProject(id) {
    const { repo, projects } = get();
    if (!repo || !projects.some((project) => project.id === id)) return false;
    const loaded = await useProjectStore.getState().loadProject(id);
    if (!loaded) return false;
    useViewStore.getState().resetForProjectSwitch();
    const navigation = touchProject(get().navigation, id);
    set({ navigation });
    await persistNavigation(repo, navigation, set);
    return true;
  },

  async createProject(name, source) {
    const repo = requireRepository(get().repo);
    const projectName = normalizeProjectName(name);
    const base = source ? structuredClone(source) : createEmptyFile({ name: projectName });
    const now = new Date().toISOString();
    const file = normalizeFile(
      {
        ...base,
        project: { ...base.project, name: projectName },
        viewState: { ...base.viewState, selectedTaskId: null },
        meta: source ? { ...base.meta, updatedAt: now } : base.meta,
      },
      { getHolidays },
    );
    const snapshot = await repo.createProject({ file });
    set((state) => ({ projects: [snapshot.summary, ...state.projects] }));
    const navigation = touchProject(get().navigation, snapshot.summary.id);
    set({ navigation });
    await persistNavigation(repo, navigation, set);
    return snapshot.summary.id;
  },

  async renameProject(id, name) {
    const repo = requireRepository(get().repo);
    const projectName = normalizeProjectName(name);
    const active = useProjectStore.getState();
    if (active.activeProjectId === id) {
      active.setFile({ ...active.file, project: { ...active.file.project, name: projectName } });
      await useProjectStore.getState().flushPendingSave();
    } else {
      const snapshot = await repo.loadProject(id);
      if (!snapshot) throw new Error('项目不存在');
      const file = {
        ...snapshot.file,
        project: { ...snapshot.file.project, name: projectName },
        meta: { ...snapshot.file.meta, updatedAt: new Date().toISOString() },
      };
      await repo.saveProject(id, file, { expectedRevision: snapshot.revision });
    }
    await get().refresh();
  },

  async duplicateProject(id) {
    const repo = requireRepository(get().repo);
    if (useProjectStore.getState().activeProjectId === id) {
      await useProjectStore.getState().flushPendingSave();
    }
    const snapshot = await repo.loadProject(id);
    if (!snapshot) throw new Error('项目不存在');
    return get().createProject(`${snapshot.file.project.name} 副本`, snapshot.file);
  },

  async moveToTrash(id) {
    const repo = requireRepository(get().repo);
    const activeStore = useProjectStore.getState();
    if (activeStore.activeProjectId === id) await activeStore.flushPendingSave();
    await repo.moveToTrash(id);
    const navigation = removeProjectFromNavigation(get().navigation, id);
    const remaining = get().projects.filter((project) => project.id !== id);
    const nextProjectId = navigation.openTabs.at(-1)?.projectId ?? remaining[0]?.id ?? null;
    if (activeStore.activeProjectId === id) activeStore.unloadProject();
    set({ navigation });
    await Promise.all([persistNavigation(repo, navigation, set), get().refresh()]);
    return nextProjectId;
  },

  async restoreProject(id) {
    const repo = requireRepository(get().repo);
    await repo.restoreProject(id);
    await get().refresh();
  },

  async deleteProjectPermanently(id) {
    const repo = requireRepository(get().repo);
    await repo.deleteProjectPermanently(id);
    const navigation = removeProjectFromNavigation(get().navigation, id);
    set({ navigation });
    await Promise.all([persistNavigation(repo, navigation, set), get().refresh()]);
  },

  toggleFavorite(id) {
    const current = get().navigation;
    const favorite = current.favoriteProjectIds.includes(id);
    const navigation = {
      ...current,
      favoriteProjectIds: favorite
        ? current.favoriteProjectIds.filter((projectId) => projectId !== id)
        : [...current.favoriteProjectIds, id],
    };
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
  },

  togglePinned(id) {
    const current = get().navigation;
    const existing = current.openTabs.find((tab) => tab.projectId === id);
    const tabs = existing
      ? current.openTabs.map((tab) =>
          tab.projectId === id ? { ...tab, pinned: !tab.pinned } : tab,
        )
      : [...current.openTabs, { projectId: id, pinned: true }];
    const navigation = { ...current, openTabs: sortTabs(tabs) };
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
  },

  closeTab(id) {
    const current = get().navigation;
    const tabs = current.openTabs.filter((tab) => tab.projectId !== id);
    const navigation = { ...current, openTabs: tabs };
    const activeId = useProjectStore.getState().activeProjectId;
    const nextProjectId =
      activeId === id
        ? (tabs.at(-1)?.projectId ?? get().projects.find((p) => p.id !== id)?.id ?? null)
        : activeId;
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
    return nextProjectId;
  },

  moveTab(id, direction) {
    const current = get().navigation;
    const tabs = [...current.openTabs];
    const index = tabs.findIndex((tab) => tab.projectId === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= tabs.length) return;
    const [tab] = tabs.splice(index, 1);
    tabs.splice(nextIndex, 0, tab!);
    const navigation = { ...current, openTabs: tabs };
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
  },

  reorderTab(sourceId, targetId) {
    if (sourceId === targetId) return;
    const current = get().navigation;
    const tabs = [...current.openTabs];
    const sourceIndex = tabs.findIndex((tab) => tab.projectId === sourceId);
    const targetIndex = tabs.findIndex((tab) => tab.projectId === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = tabs.splice(sourceIndex, 1);
    tabs.splice(targetIndex, 0, source!);
    const navigation = { ...current, openTabs: tabs };
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
  },
}));

function normalizeProjectName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error('项目名称不能为空');
  if (normalized.length > 80) throw new Error('项目名称不能超过 80 个字符');
  return normalized;
}

function requireRepository(repo: DataRepository | null): DataRepository {
  if (!repo) throw new Error('项目存储尚未初始化');
  return repo;
}

function touchProject(state: ProjectNavigationState, projectId: ProjectId): ProjectNavigationState {
  const now = new Date().toISOString();
  const existingTab = state.openTabs.find((tab) => tab.projectId === projectId);
  const openTabs = existingTab ? state.openTabs : [...state.openTabs, { projectId, pinned: false }];
  return {
    ...state,
    lastActiveProjectId: projectId,
    openTabs: sortTabs(openTabs),
    recentProjects: [
      { projectId, lastOpenedAt: now },
      ...state.recentProjects.filter((recent) => recent.projectId !== projectId),
    ].slice(0, 20),
  };
}

function sortTabs(tabs: ProjectNavigationState['openTabs']): ProjectNavigationState['openTabs'] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

function removeProjectFromNavigation(
  state: ProjectNavigationState,
  projectId: ProjectId,
): ProjectNavigationState {
  return {
    lastActiveProjectId: state.lastActiveProjectId === projectId ? null : state.lastActiveProjectId,
    openTabs: state.openTabs.filter((tab) => tab.projectId !== projectId),
    favoriteProjectIds: state.favoriteProjectIds.filter((id) => id !== projectId),
    recentProjects: state.recentProjects.filter((recent) => recent.projectId !== projectId),
  };
}

function sanitizeNavigation(
  state: ProjectNavigationState,
  projects: ProjectSummary[],
): ProjectNavigationState {
  const validIds = new Set(projects.map((project) => project.id));
  const lastActiveProjectId =
    state.lastActiveProjectId && validIds.has(state.lastActiveProjectId)
      ? state.lastActiveProjectId
      : (projects[0]?.id ?? null);
  return {
    lastActiveProjectId,
    openTabs: state.openTabs.filter((tab) => validIds.has(tab.projectId)),
    favoriteProjectIds: state.favoriteProjectIds.filter((id) => validIds.has(id)),
    recentProjects: state.recentProjects.filter((recent) => validIds.has(recent.projectId)),
  };
}

async function persistNavigation(
  repo: DataRepository,
  navigation: ProjectNavigationState,
  set: (partial: Partial<ProjectCatalogState>) => void,
): Promise<void> {
  try {
    await repo.saveNavigationState(navigation);
    set({ preferenceError: null });
  } catch (error) {
    set({ preferenceError: (error as Error).message });
  }
}
