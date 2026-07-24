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
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { useProjectCatalogStore } from '@/store/useProjectCatalogStore';
import { useProjectStore } from '@/store/useProjectStore';
import type { ProjectSummary } from '@/data/repository';
import { ConfirmDialog, ProjectNameDialog } from './ProjectDialogs';

export function ProjectHeader() {
  const navigate = useNavigate();
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
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
  const [draggedTab, setDraggedTab] = useState<string | null>(null);

  const activeSummary = projects.find((project) => project.id === activeProjectId);
  const tabs = navigation.openTabs
    .map((tab) => ({ ...tab, project: projects.find((project) => project.id === tab.projectId) }))
    .filter((tab): tab is typeof tab & { project: ProjectSummary } => Boolean(tab.project));
  const visibleTabs = tabs.slice(0, 6);
  const overflowTabs = tabs.slice(6);
  const isFavorite = activeProjectId
    ? navigation.favoriteProjectIds.includes(activeProjectId)
    : false;
  const isPinned = activeProjectId
    ? navigation.openTabs.some((tab) => tab.projectId === activeProjectId && tab.pinned)
    : false;

  const goToProject = (id: string) => {
    setSwitcherOpen(false);
    navigate(`/projects/${id}`);
  };

  const handleCloseTab = (id: string) => {
    const nextId = closeTab(id);
    if (id === activeProjectId) navigate(nextId ? `/projects/${nextId}` : '/projects');
  };

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-elevated px-2 shadow-[0_1px_0_rgb(var(--color-border)/0.35)]">
        <button
          type="button"
          onClick={() => navigate('/projects')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-white shadow-sm"
          title="项目中心"
        >
          G
        </button>

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
              className="flex min-w-0 max-w-[260px] items-center gap-2 rounded-xl border border-transparent px-2.5 py-1.5 text-left transition hover:border-border hover:bg-bg"
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
                favorites={navigation.favoriteProjectIds}
                recentIds={navigation.recentProjects.map((recent) => recent.projectId)}
                onOpenProject={goToProject}
                onCreate={() => {
                  setSwitcherOpen(false);
                  setCreateOpen(true);
                }}
                onShowAll={() => {
                  setSwitcherOpen(false);
                  navigate('/projects');
                }}
              />
              <Popover.Arrow className="fill-bg-elevated" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <div className="hidden min-w-0 flex-1 items-center gap-1 overflow-hidden md:flex">
          {visibleTabs.map((tab) => (
            <div
              key={tab.projectId}
              draggable
              onDragStart={() => setDraggedTab(tab.projectId)}
              onDragEnd={() => setDraggedTab(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (draggedTab) reorderTab(draggedTab, tab.projectId);
                setDraggedTab(null);
              }}
              className={cn(
                'group flex h-8 max-w-[180px] shrink-0 items-center gap-1 rounded-lg border px-2 transition',
                tab.projectId === activeProjectId
                  ? 'border-primary/25 bg-primary/10 text-primary'
                  : 'border-transparent text-fg-muted hover:border-border hover:bg-bg hover:text-fg',
                draggedTab === tab.projectId && 'opacity-50',
              )}
            >
              {tab.pinned ? <Pin size={12} className="shrink-0" /> : null}
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-xs font-medium"
                onClick={() => goToProject(tab.projectId)}
                title={tab.project.name}
              >
                {tab.project.name}
              </button>
              {!tab.pinned ? (
                <button
                  type="button"
                  onClick={() => handleCloseTab(tab.projectId)}
                  className="rounded p-0.5 opacity-0 hover:bg-border/60 group-hover:opacity-100 focus:opacity-100"
                  aria-label={`关闭 ${tab.project.name}`}
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
          ))}
          {overflowTabs.length > 0 ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-fg-muted hover:bg-bg hover:text-fg">
                  更多 <ChevronDown size={13} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="z-40 min-w-48 rounded-xl border border-border bg-bg-elevated p-1 shadow-xl">
                  {overflowTabs.map((tab) => (
                    <DropdownMenu.Item
                      key={tab.projectId}
                      onSelect={() => goToProject(tab.projectId)}
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
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-bg hover:text-fg"
          title="新建项目"
        >
          <Plus size={17} />
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-bg hover:text-fg"
              title="项目操作"
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
              <MenuItem icon={<Pencil size={15} />} onSelect={() => setRenameOpen(true)}>
                重命名
              </MenuItem>
              <MenuItem
                icon={<Copy size={15} />}
                onSelect={() => {
                  if (activeProjectId) {
                    void duplicateProject(activeProjectId).then((id) =>
                      navigate(`/projects/${id}`),
                    );
                  }
                }}
              >
                复制项目
              </MenuItem>
              <MenuItem
                icon={<Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />}
                onSelect={() => activeProjectId && toggleFavorite(activeProjectId)}
              >
                {isFavorite ? '取消收藏' : '收藏项目'}
              </MenuItem>
              <MenuItem
                icon={isPinned ? <PinOff size={15} /> : <Pin size={15} />}
                onSelect={() => activeProjectId && togglePinned(activeProjectId)}
              >
                {isPinned ? '取消固定标签' : '固定标签'}
              </MenuItem>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <MenuItem danger icon={<Trash2 size={15} />} onSelect={() => setTrashOpen(true)}>
                移入回收站
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>

      <ProjectNameDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="新建项目"
        description="创建一个独立的甘特项目，之后可随时从顶部切换。"
        submitLabel="创建并打开"
        onSubmit={async (name) => {
          const id = await createProject(name);
          navigate(`/projects/${id}`);
        }}
      />
      <ProjectNameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="重命名项目"
        initialValue={activeName}
        submitLabel="保存"
        onSubmit={async (name) => {
          if (activeProjectId) await renameProject(activeProjectId, name);
        }}
      />
      <ConfirmDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title="移入回收站？"
        description={
          <>
            项目“<strong className="text-fg">{activeSummary?.name ?? activeName}</strong>
            ”将从项目列表中移除，之后仍可在回收站恢复。
          </>
        }
        confirmLabel="移入回收站"
        danger
        onConfirm={async () => {
          if (!activeProjectId) return;
          const nextId = await moveToTrash(activeProjectId);
          navigate(nextId ? `/projects/${nextId}` : '/projects');
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
                {project.taskCount ? `${project.progress}%` : '空项目'}
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
            placeholder="搜索项目…"
            className="w-full rounded-xl border border-border bg-bg py-2 pl-9 pr-3 text-sm text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white hover:bg-primary/90"
          title="新建项目"
        >
          <Plus size={17} />
        </button>
      </div>
      <div className="max-h-[55vh] overflow-y-auto px-1 pb-1">
        {normalizedQuery ? renderSection('搜索结果', filtered) : null}
        {!normalizedQuery ? renderSection('收藏', favoriteProjects) : null}
        {!normalizedQuery ? renderSection('最近访问', recentProjects) : null}
        {!normalizedQuery ? renderSection('全部项目', allProjects) : null}
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-fg-muted">没有找到项目</div>
        ) : null}
      </div>
      <div className="mt-1 border-t border-border p-1">
        <button
          type="button"
          onClick={onShowAll}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-fg hover:bg-bg"
        >
          <LayoutGrid size={15} /> 查看全部项目
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
