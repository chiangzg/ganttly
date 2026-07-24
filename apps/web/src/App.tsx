import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { GanttView } from './components/GanttView';
import { ProjectCenter } from './components/projects/ProjectCenter';
import { getRepository } from './data/createRepository';
import { useProjectCatalogStore } from './store/useProjectCatalogStore';
import { useProjectStore } from './store/useProjectStore';

export function App() {
  const init = useProjectCatalogStore((state) => state.init);
  const dirty = useProjectStore((state) => state.dirty);

  useEffect(() => {
    if (useProjectCatalogStore.getState().status === 'idle') void init(getRepository());
  }, [init]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  return (
    <Tooltip.Provider delayDuration={400}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/projects" element={<ProjectCenter />} />
          <Route path="/projects/trash" element={<ProjectCenter trashMode />} />
          <Route path="/projects/:projectId" element={<ProjectEditorRoute />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </BrowserRouter>
    </Tooltip.Provider>
  );
}

function RootRedirect() {
  const status = useProjectCatalogStore((state) => state.status);
  const projects = useProjectCatalogStore((state) => state.projects);
  const createProject = useProjectCatalogStore((state) => state.createProject);
  const lastActiveProjectId = useProjectCatalogStore(
    (state) => state.navigation.lastActiveProjectId,
  );
  const [creatingTestProject, setCreatingTestProject] = useState(false);
  const creatingTestProjectRef = useRef(false);

  useEffect(() => {
    if (
      import.meta.env.VITE_E2E === '1' &&
      status === 'ready' &&
      projects.length === 0 &&
      !creatingTestProjectRef.current
    ) {
      creatingTestProjectRef.current = true;
      setCreatingTestProject(true);
      void createProject('我的项目').finally(() => {
        creatingTestProjectRef.current = false;
        setCreatingTestProject(false);
      });
    }
  }, [createProject, projects.length, status]);

  if (
    status === 'idle' ||
    status === 'loading' ||
    creatingTestProject ||
    (import.meta.env.VITE_E2E === '1' && projects.length === 0)
  ) {
    return <FullPageLoading />;
  }
  const target =
    (lastActiveProjectId && projects.some((project) => project.id === lastActiveProjectId)
      ? lastActiveProjectId
      : projects[0]?.id) ?? null;
  return <Navigate to={target ? `/projects/${target}` : '/projects'} replace />;
}

function ProjectEditorRoute() {
  const { projectId } = useParams();
  const status = useProjectCatalogStore((state) => state.status);
  const projects = useProjectCatalogStore((state) => state.projects);
  const trash = useProjectCatalogStore((state) => state.trash);
  const activateProject = useProjectCatalogStore((state) => state.activateProject);
  const restoreProject = useProjectCatalogStore((state) => state.restoreProject);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const loadState = useProjectStore((state) => state.loadState);
  const saveError = useProjectStore((state) => state.lastSaveError);
  const [attemptedId, setAttemptedId] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || status !== 'ready') return;
    let cancelled = false;
    void activateProject(projectId).finally(() => {
      if (!cancelled) setAttemptedId(projectId);
    });
    return () => {
      cancelled = true;
    };
  }, [activateProject, projectId, status]);

  if (status === 'idle' || status === 'loading' || loadState === 'loading') {
    return <FullPageLoading />;
  }
  if (!projectId) return <Navigate to="/projects" replace />;
  const trashedProject = trash.find((project) => project.id === projectId);
  if (trashedProject) {
    return (
      <MessagePage
        title="项目已在回收站"
        message={`“${trashedProject.name}”需要恢复后才能继续编辑。`}
        action={
          <button
            type="button"
            onClick={() => void restoreProject(projectId)}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white"
          >
            恢复项目
          </button>
        }
      />
    );
  }
  const exists = projects.some((project) => project.id === projectId);
  if (attemptedId === projectId && (!exists || loadState === 'missing')) {
    return <MessagePage title="项目不存在" message="该项目可能已经被删除或链接无效。" />;
  }
  if (attemptedId === projectId && loadState === 'error') {
    return <MessagePage title="无法打开项目" message={saveError ?? '加载项目失败'} />;
  }
  if (activeProjectId !== projectId || loadState !== 'ready') return <FullPageLoading />;
  return <GanttView />;
}

function FullPageLoading() {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-fg-muted">
      <div className="flex items-center gap-2 text-sm">
        <LoaderCircle size={18} className="animate-spin text-primary" /> 正在加载项目…
      </div>
    </div>
  );
}

function MessagePage({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-bg px-6">
      <div className="max-w-md rounded-3xl border border-border bg-bg-elevated p-8 text-center shadow-xl">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-warning/10 text-warning">
          <AlertTriangle size={25} />
        </span>
        <h1 className="mt-5 text-xl font-semibold text-fg">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-fg-muted">{message}</p>
        <div className="mt-6 flex justify-center gap-2">
          {action}
          <Link
            to="/projects"
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg"
          >
            返回项目中心
          </Link>
        </div>
      </div>
    </div>
  );
}
