import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArchiveRestore,
  ArrowLeft,
  CalendarDays,
  Copy,
  FolderPlus,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectSummary } from '@/data/repository';
import { cn } from '@/lib/cn';
import { useProjectCatalogStore } from '@/store/useProjectCatalogStore';
import { ConfirmDialog, ProjectNameDialog } from './ProjectDialogs';
import { ProjectDot } from './ProjectHeader';

type Filter = 'all' | 'favorites' | 'recent';
type Sort = 'recent' | 'updated' | 'name';

export function ProjectCenter({ trashMode = false }: { trashMode?: boolean }) {
  const navigate = useNavigate();
  const projects = useProjectCatalogStore((state) => (trashMode ? state.trash : state.projects));
  const navigation = useProjectCatalogStore((state) => state.navigation);
  const status = useProjectCatalogStore((state) => state.status);
  const error = useProjectCatalogStore((state) => state.error);
  const refresh = useProjectCatalogStore((state) => state.refresh);
  const createProject = useProjectCatalogStore((state) => state.createProject);
  const renameProject = useProjectCatalogStore((state) => state.renameProject);
  const duplicateProject = useProjectCatalogStore((state) => state.duplicateProject);
  const moveToTrash = useProjectCatalogStore((state) => state.moveToTrash);
  const restoreProject = useProjectCatalogStore((state) => state.restoreProject);
  const deletePermanently = useProjectCatalogStore((state) => state.deleteProjectPermanently);
  const toggleFavorite = useProjectCatalogStore((state) => state.toggleFavorite);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [trashTarget, setTrashTarget] = useState<ProjectSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const recentRank = new Map(
    navigation.recentProjects.map((recent, index) => [recent.projectId, index]),
  );
  const shown = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return projects
      .filter((project) => !normalized || project.name.toLocaleLowerCase().includes(normalized))
      .filter((project) =>
        filter === 'favorites'
          ? navigation.favoriteProjectIds.includes(project.id)
          : filter === 'recent'
            ? recentRank.has(project.id)
            : true,
      )
      .sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
        if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
        return (recentRank.get(a.id) ?? 9999) - (recentRank.get(b.id) ?? 9999);
      });
  }, [filter, navigation.favoriteProjectIds, projects, query, recentRank, sort]);

  return (
    <div className="min-h-full bg-bg">
      <header className="sticky top-0 z-20 border-b border-border bg-bg-elevated/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-5">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary font-bold text-white shadow-sm"
          >
            G
          </button>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-fg">
              {trashMode ? '项目回收站' : '项目中心'}
            </h1>
            <p className="text-xs text-fg-muted">
              {trashMode ? '恢复项目或永久删除' : '集中管理和快速切换所有项目'}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {trashMode ? (
              <button
                type="button"
                onClick={() => navigate('/projects')}
                className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg"
              >
                <ArrowLeft size={16} /> 返回项目中心
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => navigate('/projects/trash')}
                  className="hidden items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-fg-muted hover:bg-bg hover:text-fg sm:flex"
                >
                  <Trash2 size={16} /> 回收站
                </button>
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="flex items-center gap-2 rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary/90"
                >
                  <Plus size={16} /> 新建项目
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-8">
        {!trashMode ? (
          <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1 lg:max-w-md">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索项目…"
                className="w-full rounded-xl border border-border bg-bg-elevated py-2.5 pl-10 pr-3 text-sm text-fg shadow-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-border bg-bg-elevated p-1 shadow-sm">
              {(
                [
                  ['all', '全部'],
                  ['favorites', '收藏'],
                  ['recent', '最近访问'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-sm transition',
                    filter === value
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-fg-muted hover:bg-bg hover:text-fg',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as Sort)}
              className="rounded-xl border border-border bg-bg-elevated px-3 py-2.5 text-sm text-fg shadow-sm outline-none"
            >
              <option value="recent">最近打开</option>
              <option value="updated">最近更新</option>
              <option value="name">项目名称</option>
            </select>
          </div>
        ) : null}

        {status === 'loading' ? <ProjectGridSkeleton /> : null}
        {error ? (
          <div className="rounded-2xl border border-danger/30 bg-danger/5 p-5 text-sm text-danger">
            无法加载项目：{error}
          </div>
        ) : null}

        {status !== 'loading' && shown.length === 0 ? (
          <EmptyState
            trashMode={trashMode}
            hasQuery={Boolean(query)}
            onCreate={() => setCreateOpen(true)}
          />
        ) : null}

        {shown.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {!trashMode && !query && filter === 'all' ? (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="group flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-elevated/50 p-6 text-fg-muted transition hover:border-primary/50 hover:bg-bg-elevated hover:text-primary hover:shadow-lg"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary transition group-hover:scale-105">
                  <FolderPlus size={23} />
                </span>
                <span className="mt-3 text-sm font-semibold">新建项目</span>
                <span className="mt-1 text-xs">从空白甘特图开始</span>
              </button>
            ) : null}
            {shown.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                trashMode={trashMode}
                favorite={navigation.favoriteProjectIds.includes(project.id)}
                onOpen={() => navigate(`/projects/${project.id}`)}
                onFavorite={() => toggleFavorite(project.id)}
                onRename={() => setRenameTarget(project)}
                onDuplicate={() =>
                  void duplicateProject(project.id).then((id) => navigate(`/projects/${id}`))
                }
                onTrash={() => setTrashTarget(project)}
                onRestore={() => void restoreProject(project.id)}
                onDelete={() => setDeleteTarget(project)}
              />
            ))}
          </div>
        ) : null}
      </main>

      <ProjectNameDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="新建项目"
        description="项目之间的数据、撤销历史和视图状态相互独立。"
        submitLabel="创建并打开"
        onSubmit={async (name) => {
          const id = await createProject(name);
          navigate(`/projects/${id}`);
        }}
      />
      <ProjectNameDialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        title="重命名项目"
        initialValue={renameTarget?.name ?? ''}
        submitLabel="保存"
        onSubmit={async (name) => {
          if (renameTarget) await renameProject(renameTarget.id, name);
        }}
      />
      <ConfirmDialog
        open={Boolean(trashTarget)}
        onOpenChange={(open) => !open && setTrashTarget(null)}
        title="移入回收站？"
        description={<>项目“{trashTarget?.name}”之后仍可恢复。</>}
        confirmLabel="移入回收站"
        danger
        onConfirm={async () => {
          if (trashTarget) await moveToTrash(trashTarget.id);
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="永久删除项目？"
        description={<>项目“{deleteTarget?.name}”及其所有任务将永久删除，此操作无法撤销。</>}
        confirmLabel="永久删除"
        danger
        onConfirm={async () => {
          if (deleteTarget) await deletePermanently(deleteTarget.id);
        }}
      />
    </div>
  );
}

function ProjectCard({
  project,
  trashMode,
  favorite,
  onOpen,
  onFavorite,
  onRename,
  onDuplicate,
  onTrash,
  onRestore,
  onDelete,
}: {
  project: ProjectSummary;
  trashMode: boolean;
  favorite: boolean;
  onOpen(): void;
  onFavorite(): void;
  onRename(): void;
  onDuplicate(): void;
  onTrash(): void;
  onRestore(): void;
  onDelete(): void;
}) {
  return (
    <article className="group relative flex min-h-52 flex-col rounded-2xl border border-border bg-bg-elevated p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-xl">
      <div className="flex items-start gap-3">
        <ProjectDot id={project.id} size="lg" />
        <button
          type="button"
          onClick={trashMode ? undefined : onOpen}
          className="min-w-0 flex-1 text-left"
        >
          <h2 className="truncate text-base font-semibold text-fg">{project.name}</h2>
          <p className="mt-1 text-xs text-fg-muted">更新于 {formatRelative(project.updatedAt)}</p>
        </button>
        {!trashMode ? (
          <button
            type="button"
            onClick={onFavorite}
            className={cn(
              'rounded-lg p-1.5 hover:bg-bg',
              favorite ? 'text-warning' : 'text-fg-muted opacity-60 group-hover:opacity-100',
            )}
            aria-label={favorite ? '取消收藏' : '收藏项目'}
          >
            <Star size={16} fill={favorite ? 'currentColor' : 'none'} />
          </button>
        ) : null}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              aria-label={`项目操作 ${project.name}`}
              className="rounded-lg p-1.5 text-fg-muted opacity-60 hover:bg-bg hover:text-fg group-hover:opacity-100"
            >
              <MoreHorizontal size={17} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="z-40 min-w-44 rounded-xl border border-border bg-bg-elevated p-1.5 shadow-xl"
            >
              {trashMode ? (
                <>
                  <CardMenuItem icon={<ArchiveRestore size={15} />} onSelect={onRestore}>
                    恢复项目
                  </CardMenuItem>
                  <CardMenuItem danger icon={<Trash2 size={15} />} onSelect={onDelete}>
                    永久删除
                  </CardMenuItem>
                </>
              ) : (
                <>
                  <CardMenuItem icon={<Pencil size={15} />} onSelect={onRename}>
                    重命名
                  </CardMenuItem>
                  <CardMenuItem icon={<Copy size={15} />} onSelect={onDuplicate}>
                    复制项目
                  </CardMenuItem>
                  <CardMenuItem danger icon={<Trash2 size={15} />} onSelect={onTrash}>
                    移入回收站
                  </CardMenuItem>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <div className="mt-auto pt-7">
        <div className="mb-2 flex items-center justify-between text-xs text-fg-muted">
          <span>
            {project.taskCount
              ? `${project.completedTaskCount}/${project.taskCount} 个任务完成`
              : '空项目'}
          </span>
          <span className="font-medium tabular-nums text-fg">{project.progress}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-border/70">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${project.progress}%` }}
          />
        </div>
        <div className="mt-4 flex items-center gap-2 text-xs text-fg-muted">
          <CalendarDays size={14} />
          {project.startDate && project.endDate
            ? `${project.startDate} — ${project.endDate}`
            : '尚未安排日期'}
        </div>
      </div>
    </article>
  );
}

function CardMenuItem({
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

function EmptyState({
  trashMode,
  hasQuery,
  onCreate,
}: {
  trashMode: boolean;
  hasQuery: boolean;
  onCreate(): void;
}) {
  return (
    <div className="flex min-h-[55vh] flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-bg-elevated/50 px-6 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
        {trashMode ? <Trash2 size={28} /> : <LayoutGrid size={28} />}
      </span>
      <h2 className="mt-5 text-lg font-semibold text-fg">
        {trashMode ? '回收站是空的' : hasQuery ? '没有找到匹配项目' : '创建你的第一个项目'}
      </h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-fg-muted">
        {trashMode
          ? '移入回收站的项目会出现在这里，本地版本不会自动清理。'
          : hasQuery
            ? '尝试更换关键词或筛选条件。'
            : '每个项目都有独立的任务、资源、视图状态和撤销历史。'}
      </p>
      {!trashMode && !hasQuery ? (
        <button
          type="button"
          onClick={onCreate}
          className="mt-5 flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-primary/90"
        >
          <Plus size={16} /> 新建项目
        </button>
      ) : null}
    </div>
  );
}

function ProjectGridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className="h-52 animate-pulse rounded-2xl border border-border bg-bg-elevated"
        />
      ))}
    </div>
  );
}

function formatRelative(value: string): string {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return value.slice(0, 10);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString('zh-CN');
}
