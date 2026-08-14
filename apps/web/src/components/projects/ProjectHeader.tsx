import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import {
  Archive,
  ChevronDown,
  ChevronsUpDown,
  Copy,
  FolderKanban,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { useProjectCatalogStore } from '@/store/useProjectCatalogStore';
import { useProjectStore } from '@/store/useProjectStore';
import { useScopeStore } from '@/store/useScopeStore';
import type { ProjectSummary } from '@/data/repository';
import { refEqual, refKey, type ProjectRef } from '@/data/projectRef';
import { buildProjectPath, buildScopePath, LOCAL_SCOPE } from '@/lib/routing';
import { ConfirmDialog, CreateProjectDialog, ProjectNameDialog } from './ProjectDialogs';

export function ProjectHeader() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeProjectRef = useProjectStore((state) => state.activeProjectRef);
  const activeName = useProjectStore((state) => state.file.project.name);
  const projects = useProjectCatalogStore((state) => state.projects);
  const navigation = useProjectCatalogStore((state) => state.navigation);
  const createProject = useProjectCatalogStore((state) => state.createProject);
  const renameProject = useProjectCatalogStore((state) => state.renameProject);
  const duplicateProject = useProjectCatalogStore((state) => state.duplicateProject);
  const moveToTrash = useProjectCatalogStore((state) => state.moveToTrash);
  const toggleFavorite = useProjectCatalogStore((state) => state.toggleFavorite);
  const togglePinned = useProjectCatalogStore((state) => state.togglePinned);
  const closeTab = useProjectCatalogStore((state) => state.closeTab);
  const reorderTab = useProjectCatalogStore((state) => state.reorderTab);
  const refresh = useProjectCatalogStore((state) => state.refresh);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [draggedTab, setDraggedTab] = useState<ProjectRef | null>(null);

  const activeProjectId = activeProjectRef?.projectId ?? null;
  const activeScope = useScopeStore((state) => state.activeScope);
  const activeSummary = projects.find((project) => project.id === activeProjectId);
  const tabs = navigation.openTabs
    .map((tab) => ({
      ...tab,
      project: projects.find((project) => project.id === tab.ref.projectId),
    }))
    .filter((tab): tab is typeof tab & { project: ProjectSummary } => Boolean(tab.project));
  const visibleTabs = tabs.slice(0, 6);
  const overflowTabs = tabs.slice(6);
  const isFavorite = activeProjectRef
    ? navigation.favoriteRefs.some((r) => refEqual(r, activeProjectRef))
    : false;
  const isPinned = activeProjectRef
    ? navigation.openTabs.some((tab) => refEqual(tab.ref, activeProjectRef) && tab.pinned)
    : false;

  // Tabs can point at any instance (navigation is global); navigating must
  // carry the full ref, never assume the local scope.
  const goToProject = (ref: ProjectRef) => {
    setSwitcherOpen(false);
    navigate(buildProjectPath(ref));
  };
  // Switcher lists the active catalog; resolve its ids against the active scope.
  const goToCatalogProject = (id: string) => {
    goToProject({
      instanceId: activeScope.instanceId,
      workspaceId: activeScope.workspaceId,
      projectId: id,
    });
  };

  const handleCloseTab = (ref: ProjectRef) => {
    const nextRef = closeTab(ref);
    if (activeProjectRef && refEqual(activeProjectRef, ref)) {
      navigate(nextRef ? buildProjectPath(nextRef) : buildScopePath(LOCAL_SCOPE));
    }
  };

  return (
    <>
      <header
        data-project-header
        className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border/80 bg-bg-elevated px-2.5"
      >
        <button
          type="button"
          onClick={() => navigate(buildScopePath(LOCAL_SCOPE))}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-bold text-primary outline-none transition hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-primary/35"
          title={t('project.homeTitle')}
        >
          G
        </button>
        <div className="mx-1 h-5 w-px shrink-0 bg-border/80" aria-hidden="true" />

        <Popover.Root
          open={switcherOpen}
          onOpenChange={(open) => {
            setSwitcherOpen(open);
            if (open) void refresh();
          }}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              className="flex h-8 min-w-0 max-w-[260px] items-center gap-2 rounded-lg px-2 text-left outline-none transition hover:bg-bg focus-visible:ring-2 focus-visible:ring-primary/35"
            >
              <ProjectDot id={activeProjectId ?? 'empty'} />
              <span className="truncate text-sm font-semibold text-fg">{activeName}</span>
              <ChevronsUpDown size={14} className="shrink-0 text-fg-muted" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={8}
              className="z-40 w-[min(380px,calc(100vw-24px))] rounded-2xl border border-border bg-bg-elevated p-2 shadow-2xl outline-none"
            >
              <ProjectSwitcher
                projects={projects}
                activeProjectId={activeProjectId}
                favorites={navigation.favoriteRefs
                  .filter(
                    (r) =>
                      r.instanceId === activeScope.instanceId &&
                      r.workspaceId === activeScope.workspaceId,
                  )
                  .map((r) => r.projectId)}
                recentIds={navigation.recentProjects
                  .filter(
                    (r) =>
                      r.ref.instanceId === activeScope.instanceId &&
                      r.ref.workspaceId === activeScope.workspaceId,
                  )
                  .map((r) => r.ref.projectId)}
                onOpenProject={goToCatalogProject}
                onCreate={() => {
                  setSwitcherOpen(false);
                  setCreateOpen(true);
                }}
                onShowAll={() => {
                  setSwitcherOpen(false);
                  navigate(buildScopePath(LOCAL_SCOPE));
                }}
              />
              <Popover.Arrow className="fill-bg-elevated" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <div className="hidden min-w-0 flex-1 items-center gap-0.5 overflow-hidden pl-1 md:flex">
          {visibleTabs.map((tab) => (
            <div
              key={refKey(tab.ref)}
              draggable
              onDragStart={() => setDraggedTab(tab.ref)}
              onDragEnd={() => setDraggedTab(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (draggedTab) reorderTab(draggedTab, tab.ref);
                setDraggedTab(null);
              }}
              className={cn(
                'group relative flex h-8 max-w-[180px] shrink-0 items-center gap-1 rounded-lg px-2 transition',
                activeProjectRef && refEqual(tab.ref, activeProjectRef)
                  ? 'bg-primary/10 text-fg after:absolute after:-bottom-2 after:inset-x-2 after:h-0.5 after:rounded-full after:bg-primary'
                  : 'text-fg-muted hover:bg-bg hover:text-fg',
                draggedTab && refEqual(draggedTab, tab.ref) && 'opacity-50',
              )}
            >
              {tab.pinned ? <Pin size={12} className="shrink-0" /> : null}
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
                onClick={() => goToProject(tab.ref)}
                title={tab.project.name}
              >
                {tab.project.name}
              </button>
              {!tab.pinned ? (
                <button
                  type="button"
                  onClick={() => handleCloseTab(tab.ref)}
                  className={cn(
                    'rounded p-0.5 outline-none transition hover:bg-border/60 focus-visible:ring-2 focus-visible:ring-primary/35',
                    activeProjectRef && refEqual(tab.ref, activeProjectRef)
                      ? 'opacity-60 hover:opacity-100'
                      : 'opacity-0 group-hover:opacity-60 group-focus-within:opacity-60 hover:opacity-100',
                  )}
                  aria-label={t('project.closeTab', { name: tab.project.name })}
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
          ))}
          {overflowTabs.length > 0 ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-fg-muted outline-none hover:bg-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/35">
                  {t('project.moreTabs')} <ChevronDown size={13} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="z-40 min-w-48 rounded-xl border border-border bg-bg-elevated p-1 shadow-xl">
                  {overflowTabs.map((tab) => (
                    <DropdownMenu.Item
                      key={refKey(tab.ref)}
                      onSelect={() => goToProject(tab.ref)}
                      className="cursor-pointer rounded-lg px-3 py-2 text-sm text-fg outline-none hover:bg-bg focus:bg-bg"
                    >
                      {tab.project.name}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-muted outline-none transition hover:bg-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/35"
          title={t('project.newProject')}
        >
          <Plus size={17} />
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-muted outline-none transition hover:bg-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/35"
              title={t('project.groupActions')}
            >
              <MoreHorizontal size={18} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-40 min-w-52 rounded-xl border border-border bg-bg-elevated p-1.5 shadow-xl"
            >
              {/* §5.1: clear group header so the project menu's scope is
                  identifiable without a tooltip. */}
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                {t('project.groupActions')}
              </div>
              <MenuItem icon={<Pencil size={15} />} onSelect={() => setRenameOpen(true)}>
                {t('project.rename')}
              </MenuItem>
              <MenuItem
                icon={<Copy size={15} />}
                onSelect={() => {
                  if (activeProjectRef) {
                    void duplicateProject(activeProjectRef).then((ref) =>
                      navigate(buildProjectPath(ref)),
                    );
                  }
                }}
              >
                {t('project.duplicate')}
              </MenuItem>
              <MenuItem
                icon={<Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />}
                onSelect={() => activeProjectRef && toggleFavorite(activeProjectRef)}
              >
                {isFavorite ? t('project.unfavorite') : t('project.favorite')}
              </MenuItem>
              <MenuItem
                icon={isPinned ? <PinOff size={15} /> : <Pin size={15} />}
                onSelect={() => activeProjectRef && togglePinned(activeProjectRef)}
              >
                {isPinned ? t('project.unpin') : t('project.pin')}
              </MenuItem>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <MenuItem danger icon={<Trash2 size={15} />} onSelect={() => setTrashOpen(true)}>
                {t('project.moveToTrash')}
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (name, source) => {
          const ref = await createProject(name, source);
          navigate(buildProjectPath(ref));
        }}
      />
      <ProjectNameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={t('project.renameTitle')}
        initialValue={activeName}
        submitLabel={t('common.save')}
        onSubmit={async (name) => {
          if (activeProjectRef) await renameProject(activeProjectRef, name);
        }}
      />
      <ConfirmDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title={t('project.trashTitle')}
        description={t('project.trashDesc', { name: activeSummary?.name ?? activeName })}
        confirmLabel={t('project.moveToTrash')}
        danger
        onConfirm={async () => {
          if (!activeProjectRef) return;
          const nextRef = await moveToTrash(activeProjectRef);
          navigate(nextRef ? buildProjectPath(nextRef) : buildScopePath(LOCAL_SCOPE));
        }}
      />
    </>
  );
}

function ProjectSwitcher({
  projects,
  activeProjectId,
  favorites,
  recentIds,
  onOpenProject,
  onCreate,
  onShowAll,
}: {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  favorites: string[];
  recentIds: string[];
  onOpenProject(id: string): void;
  onCreate(): void;
  onShowAll(): void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      normalizedQuery
        ? projects.filter((project) => project.name.toLocaleLowerCase().includes(normalizedQuery))
        : projects,
    [normalizedQuery, projects],
  );
  const favoriteProjects = filtered.filter((project) => favorites.includes(project.id));
  const recentProjects = recentIds
    .map((id) => filtered.find((project) => project.id === id))
    .filter((project): project is ProjectSummary => Boolean(project))
    .filter((project) => !favorites.includes(project.id))
    .slice(0, 5);
  const shownIds = new Set([...favoriteProjects, ...recentProjects].map((project) => project.id));
  const allProjects = filtered.filter((project) => !shownIds.has(project.id)).slice(0, 8);
  const flatProjects = normalizedQuery
    ? filtered
    : [...favoriteProjects, ...recentProjects, ...allProjects];

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(flatProjects.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && flatProjects[selectedIndex]) {
      event.preventDefault();
      onOpenProject(flatProjects[selectedIndex]!.id);
    }
  };

  let flatIndex = 0;
  const renderSection = (title: string, items: ProjectSummary[]) => {
    if (items.length === 0) return null;
    return (
      <div className="mt-2">
        <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          {title}
        </div>
        {items.map((project) => {
          const index = flatIndex++;
          return (
            <button
              key={project.id}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => onOpenProject(project.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none',
                selectedIndex === index ? 'bg-bg' : 'hover:bg-bg',
              )}
            >
              <ProjectDot id={project.id} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                {project.name}
              </span>
              <span className="text-xs tabular-nums text-fg-muted">
                {project.taskCount ? `${project.progress}%` : t('project.switcher.emptyProject')}
              </span>
              {project.id === activeProjectId ? (
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              ) : null}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      <div className="flex items-center gap-2 p-1">
        <div className="relative min-w-0 flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t('project.switcher.searchPlaceholder')}
            className="w-full rounded-xl border border-border bg-bg py-2 pl-9 pr-3 text-sm text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white hover:bg-primary/90"
          title={t('project.newProject')}
        >
          <Plus size={17} />
        </button>
      </div>
      <div className="max-h-[55vh] overflow-y-auto px-1 pb-1">
        {normalizedQuery ? renderSection(t('project.switcher.searchResults'), filtered) : null}
        {!normalizedQuery ? renderSection(t('project.switcher.favorites'), favoriteProjects) : null}
        {!normalizedQuery ? renderSection(t('project.switcher.recent'), recentProjects) : null}
        {!normalizedQuery ? renderSection(t('project.switcher.allProjects'), allProjects) : null}
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-fg-muted">
            {t('project.switcher.noResults')}
          </div>
        ) : null}
      </div>
      <div className="mt-1 border-t border-border p-1">
        <button
          type="button"
          onClick={onShowAll}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-fg hover:bg-bg"
        >
          <LayoutGrid size={15} /> {t('project.switcher.viewAll')}
        </button>
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  children,
  danger = false,
  onSelect,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
  onSelect(): void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none hover:bg-bg focus:bg-bg',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  );
}

export function ProjectDot({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' | 'lg' }) {
  const palette = ['bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500'];
  const hash = [...id].reduce((value, character) => value + character.charCodeAt(0), 0);
  return (
    <span
      className={cn(
        'shrink-0 rounded-md shadow-sm',
        palette[hash % palette.length],
        size === 'sm' && 'h-2.5 w-2.5 rounded-sm',
        size === 'md' && 'h-4 w-4',
        size === 'lg' && 'flex h-10 w-10 items-center justify-center rounded-xl text-white',
      )}
    >
      {size === 'lg' ? <FolderKanban size={19} /> : null}
    </span>
  );
}

void Archive;
