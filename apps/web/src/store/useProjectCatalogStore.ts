import { create } from 'zustand';
import { createEmptyFile, normalizeFile, type GanttlyFile, type Holiday } from '@ganttly/schema';
import { getCalendar } from '@ganttly/calendar-data';
import {
  EMPTY_PROJECT_NAVIGATION,
  type DataRepository,
  type ProjectNavigationState,
  type ProjectRepository,
  type ProjectSummary,
} from '@/data/repository';
import { isLocalRef, refEqual, type ProjectRef } from '@/data/projectRef';
import { resolveProjectRepository } from '@/data/resolveRepository';
import { useProjectStore } from './useProjectStore';
import { useViewStore } from './useViewStore';
import { useScopeStore } from './useScopeStore';
import { useInstanceStore } from './useInstanceStore';
import { useAuthStore } from './useAuthStore';

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
  activateProject(ref: ProjectRef): Promise<boolean>;
  createProject(name: string, source?: GanttlyFile): Promise<ProjectRef>;
  renameProject(ref: ProjectRef, name: string): Promise<void>;
  duplicateProject(ref: ProjectRef): Promise<ProjectRef>;
  moveToTrash(ref: ProjectRef): Promise<ProjectRef | null>;
  restoreProject(ref: ProjectRef): Promise<void>;
  deleteProjectPermanently(ref: ProjectRef): Promise<void>;
  toggleFavorite(ref: ProjectRef): void;
  togglePinned(ref: ProjectRef): void;
  closeTab(ref: ProjectRef): ProjectRef | null;
  moveTab(ref: ProjectRef, direction: -1 | 1): void;
  reorderTab(sourceRef: ProjectRef, targetRef: ProjectRef): void;
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
    const scope = useScopeStore.getState().activeScope;
    const isLocal = scope.instanceId === 'local';
    const repo = isLocal ? get().repo : resolveScopeRepo();
    if (!repo) {
      set({ status: 'error', error: '工作区未登录或不可用' });
      return;
    }
    try {
      const summaries = await repo.listProjects({ includeDeleted: true });
      const projects = summaries.filter((project) => !project.deletedAt);
      const trash = summaries.filter((project) => Boolean(project.deletedAt));
      // Only re-sanitize navigation for the local scope — remote project lists
      // are scope-local and should not prune the global navigation state.
      if (isLocal) {
        const navRepo = get().repo;
        const navigation = sanitizeNavigation(get().navigation, projects);
        set({ projects, trash, navigation, status: 'ready', error: null });
        if (navRepo) await persistNavigation(navRepo, navigation, set);
      } else {
        set({ projects, trash, status: 'ready', error: null });
      }
    } catch (error) {
      set({ status: 'error', error: (error as Error).message });
    }
  },

  async activateProject(ref) {
    const { repo, projects } = get();
    // For local refs, verify the project exists in the list before activating.
    // Remote projects may be accessed by direct URL before the list is loaded.
    if (isLocalRef(ref) && repo && !projects.some((project) => project.id === ref.projectId))
      return false;
    const loaded = await useProjectStore.getState().loadProject(ref);
    if (!loaded) return false;
    useViewStore.getState().resetForProjectSwitch();
    const navigation = touchProject(get().navigation, ref);
    set({ navigation });
    if (repo) await persistNavigation(repo, navigation, set);
    return true;
  },

  async createProject(name, source) {
    const scope = useScopeStore.getState().activeScope;
    const repo = scope.instanceId === 'local' ? requireRepository(get().repo) : resolveScopeRepo();
    if (!repo) throw new Error('工作区未登录或不可用');
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
    const ref: ProjectRef = {
      instanceId: scope.instanceId,
      workspaceId: scope.workspaceId,
      projectId: snapshot.summary.id,
    };
    set((state) => ({ projects: [snapshot.summary, ...state.projects] }));
    // Navigation is always local-persisted regardless of the active scope.
    const navRepo = get().repo;
    const navigation = touchProject(get().navigation, ref);
    set({ navigation });
    if (navRepo) await persistNavigation(navRepo, navigation, set);
    return ref;
  },

  async renameProject(ref, name) {
    const repo = resolveRepoForRef(ref);
    if (!repo) throw new Error('工作区未登录或不可用');
    const projectName = normalizeProjectName(name);
    const active = useProjectStore.getState();
    if (active.activeProjectRef && refEqual(active.activeProjectRef, ref)) {
      active.setFile({ ...active.file, project: { ...active.file.project, name: projectName } });
      await useProjectStore.getState().flushPendingSave();
    } else {
      const snapshot = await repo.loadProject(ref.projectId);
      if (!snapshot) throw new Error('项目不存在');
      const file = {
        ...snapshot.file,
        project: { ...snapshot.file.project, name: projectName },
        meta: { ...snapshot.file.meta, updatedAt: new Date().toISOString() },
      };
      await repo.saveProject(ref.projectId, file, { expectedRevision: snapshot.revision });
    }
    await get().refresh();
  },

  async duplicateProject(ref) {
    const repo = resolveRepoForRef(ref);
    if (!repo) throw new Error('工作区未登录或不可用');
    if (activeRefEquals(ref)) {
      await useProjectStore.getState().flushPendingSave();
    }
    const snapshot = await repo.loadProject(ref.projectId);
    if (!snapshot) throw new Error('项目不存在');
    return get().createProject(`${snapshot.file.project.name} 副本`, snapshot.file);
  },

  async moveToTrash(ref) {
    const repo = resolveRepoForRef(ref);
    if (!repo) throw new Error('工作区未登录或不可用');
    const activeStore = useProjectStore.getState();
    if (activeRefEquals(ref)) await activeStore.flushPendingSave();
    await repo.moveToTrash(ref.projectId);
    const navigation = removeProjectFromNavigation(get().navigation, ref);
    const remaining = get().projects.filter((project) => project.id !== ref.projectId);
    const nextRef = navigation.openTabs.at(-1)?.ref ?? summaryRef(remaining[0]) ?? null;
    if (activeRefEquals(ref)) activeStore.unloadProject();
    set({ navigation });
    // Navigation state always persists to the local repo, whatever the scope.
    const navRepo = get().repo;
    await Promise.all([
      navRepo ? persistNavigation(navRepo, navigation, set) : Promise.resolve(),
      get().refresh(),
    ]);
    return nextRef;
  },

  async restoreProject(ref) {
    const repo = resolveRepoForRef(ref);
    if (!repo) throw new Error('工作区未登录或不可用');
    await repo.restoreProject(ref.projectId);
    await get().refresh();
  },

  async deleteProjectPermanently(ref) {
    const repo = resolveRepoForRef(ref);
    if (!repo) throw new Error('工作区未登录或不可用');
    await repo.deleteProjectPermanently(ref.projectId);
    const navigation = removeProjectFromNavigation(get().navigation, ref);
    set({ navigation });
    const navRepo = get().repo;
    await Promise.all([
      navRepo ? persistNavigation(navRepo, navigation, set) : Promise.resolve(),
      get().refresh(),
    ]);
  },

  toggleFavorite(ref) {
    const current = get().navigation;
    const favorite = current.favoriteRefs.some((r) => refEqual(r, ref));
    const navigation = {
      ...current,
      favoriteRefs: favorite
        ? current.favoriteRefs.filter((r) => !refEqual(r, ref))
        : [...current.favoriteRefs, ref],
    };
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
  },

  togglePinned(ref) {
    const current = get().navigation;
    const existing = current.openTabs.find((tab) => refEqual(tab.ref, ref));
    const tabs = existing
      ? current.openTabs.map((tab) =>
          refEqual(tab.ref, ref) ? { ...tab, pinned: !tab.pinned } : tab,
        )
      : [...current.openTabs, { ref, pinned: true }];
    const navigation = { ...current, openTabs: sortTabs(tabs) };
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
  },

  closeTab(ref) {
    const current = get().navigation;
    const tabs = current.openTabs.filter((tab) => !refEqual(tab.ref, ref));
    const navigation = { ...current, openTabs: tabs };
    const activeRef = useProjectStore.getState().activeProjectRef;
    const nextRef =
      activeRef && refEqual(activeRef, ref)
        ? (tabs.at(-1)?.ref ??
          summaryRef(get().projects.find((p) => p.id !== ref.projectId)) ??
          null)
        : activeRef;
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
    return nextRef;
  },

  moveTab(ref, direction) {
    const current = get().navigation;
    const tabs = [...current.openTabs];
    const index = tabs.findIndex((tab) => refEqual(tab.ref, ref));
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= tabs.length) return;
    const [tab] = tabs.splice(index, 1);
    tabs.splice(nextIndex, 0, tab!);
    const navigation = { ...current, openTabs: tabs };
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
  },

  reorderTab(sourceRef, targetRef) {
    if (refEqual(sourceRef, targetRef)) return;
    const current = get().navigation;
    const tabs = [...current.openTabs];
    const sourceIndex = tabs.findIndex((tab) => refEqual(tab.ref, sourceRef));
    const targetIndex = tabs.findIndex((tab) => refEqual(tab.ref, targetRef));
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = tabs.splice(sourceIndex, 1);
    tabs.splice(targetIndex, 0, source!);
    const navigation = { ...current, openTabs: tabs };
    set({ navigation });
    const repo = get().repo;
    if (repo) void persistNavigation(repo, navigation, set);
  },
}));

// --- Helpers ----------------------------------------------------------------

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

/**
 * Resolve the {@link ProjectRepository} for an arbitrary ref: the injected
 * local DataRepository for local refs, or a cached RemoteRepository for the
 * ref's instance + authenticated user. Returns null when the remote instance
 * is not yet authenticated.
 */
function resolveRepoForRef(ref: ProjectRef): ProjectRepository | null {
  if (isLocalRef(ref)) return useProjectCatalogStore.getState().repo;
  const instance = useInstanceStore.getState().findInstance(ref.instanceId);
  const profile = useAuthStore.getState().getProfile(ref.instanceId);
  if (!instance || !profile) return null;
  return resolveProjectRepository(ref, { instance, userId: profile.userId });
}

/**
 * Resolve the {@link ProjectRepository} for the currently active scope.
 * Local scope → the injected local DataRepository. Remote scope → a cached
 * RemoteRepository built from the instance config + authenticated user.
 * Returns null when the remote instance is not yet authenticated.
 */
function resolveScopeRepo(): ProjectRepository | null {
  const scope = useScopeStore.getState().activeScope;
  return resolveRepoForRef({
    instanceId: scope.instanceId,
    workspaceId: scope.workspaceId,
    projectId: '',
  });
}

/** True when the given ref matches the project store's active ref. */
function activeRefEquals(ref: ProjectRef): boolean {
  const active = useProjectStore.getState().activeProjectRef;
  return active !== null && active !== undefined && refEqual(active, ref);
}

/** Build a local ProjectRef from a summary's project id (null-safe). */
function localRefFromSummary(summary: ProjectSummary | undefined): ProjectRef | null {
  if (!summary) return null;
  return { instanceId: 'local', workspaceId: 'local', projectId: summary.id };
}

/** Build a ProjectRef for a summary in the *active* scope (null-safe). */
function summaryRef(summary: ProjectSummary | undefined): ProjectRef | null {
  if (!summary) return null;
  const scope = useScopeStore.getState().activeScope;
  return { instanceId: scope.instanceId, workspaceId: scope.workspaceId, projectId: summary.id };
}

function touchProject(state: ProjectNavigationState, ref: ProjectRef): ProjectNavigationState {
  const now = new Date().toISOString();
  const existingTab = state.openTabs.find((tab) => refEqual(tab.ref, ref));
  const openTabs = existingTab ? state.openTabs : [...state.openTabs, { ref, pinned: false }];
  return {
    ...state,
    lastActiveRef: ref,
    openTabs: sortTabs(openTabs),
    recentProjects: [
      { ref, lastOpenedAt: now },
      ...state.recentProjects.filter((recent) => !refEqual(recent.ref, ref)),
    ].slice(0, 20),
  };
}

function sortTabs(tabs: ProjectNavigationState['openTabs']): ProjectNavigationState['openTabs'] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

function removeProjectFromNavigation(
  state: ProjectNavigationState,
  ref: ProjectRef,
): ProjectNavigationState {
  return {
    lastActiveRef:
      state.lastActiveRef && refEqual(state.lastActiveRef, ref) ? null : state.lastActiveRef,
    openTabs: state.openTabs.filter((tab) => !refEqual(tab.ref, ref)),
    favoriteRefs: state.favoriteRefs.filter((r) => !refEqual(r, ref)),
    recentProjects: state.recentProjects.filter((recent) => !refEqual(recent.ref, ref)),
  };
}

function sanitizeNavigation(
  state: ProjectNavigationState,
  projects: ProjectSummary[],
): ProjectNavigationState {
  // Local project ids known to exist. Remote refs are kept as-is (they may
  // not appear in the local list — the remote scope is loaded separately).
  const validLocalIds = new Set(projects.map((project) => project.id));
  const isValid = (ref: ProjectRef): boolean =>
    ref.instanceId !== 'local' || validLocalIds.has(ref.projectId);

  const lastValid =
    state.lastActiveRef && isValid(state.lastActiveRef) ? state.lastActiveRef : null;
  const lastActiveRef = lastValid ?? localRefFromSummary(projects[0]);

  return {
    lastActiveRef,
    openTabs: state.openTabs.filter((tab) => isValid(tab.ref)),
    favoriteRefs: state.favoriteRefs.filter(isValid),
    recentProjects: state.recentProjects.filter((recent) => isValid(recent.ref)),
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
