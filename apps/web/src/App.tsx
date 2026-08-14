import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useRef, useState } from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { GanttView } from './components/GanttView';
import { ProjectCenter } from './components/projects/ProjectCenter';
import { PatSettings } from './components/settings/PatSettings';
import { getRepository } from './data/createRepository';
import {
  buildProjectPath,
  buildScopePath,
  LOCAL_SCOPE,
  localProjectRef,
  refFromParams,
} from './lib/routing';
import { useProjectCatalogStore } from './store/useProjectCatalogStore';
import { useProjectStore } from './store/useProjectStore';
import { useInstanceStore } from './store/useInstanceStore';
import { useAuthStore, consumePostLoginRedirect } from './store/useAuthStore';
import { useScopeStore } from './store/useScopeStore';

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

          {/* Multi-instance routes (canonical). */}
          <Route path={`${buildScopePath(LOCAL_SCOPE)}`} element={<ProjectCenter />} />
          <Route
            path={`${buildScopePath({ instanceId: ':instanceId', workspaceId: ':workspaceId' })}`}
          >
            <Route index element={<ProjectCenter />} />
            <Route path="trash" element={<ProjectCenter trashMode />} />
            <Route path=":projectId" element={<ProjectEditorRoute />} />
          </Route>

          {/* Legacy redirects (old bookmarks). */}
          <Route path="/projects" element={<Navigate to={buildScopePath(LOCAL_SCOPE)} replace />} />
          <Route
            path="/projects/trash"
            element={<Navigate to={`${buildScopePath(LOCAL_SCOPE)}/trash`} replace />}
          />
          <Route path="/projects/:projectId" element={<LegacyProjectRedirect />} />

          {/* Settings. */}
          <Route path="/settings/tokens" element={<PatSettings />} />

          <Route path="*" element={<Navigate to={buildScopePath(LOCAL_SCOPE)} replace />} />
        </Routes>
      </BrowserRouter>
    </Tooltip.Provider>
  );
}

function LegacyProjectRedirect() {
  const { projectId } = useParams();
  if (!projectId) return <Navigate to={buildScopePath(LOCAL_SCOPE)} replace />;
  return <Navigate to={buildProjectPath(localProjectRef(projectId))} replace />;
}

/**
 * Handles the redirect back from GitHub OAuth. The server sends the user to
 * the web root after setting the session cookie; this component verifies the
 * login succeeded, loads the remote workspaces, and navigates to the first
 * one's project center.
 */
function PostLoginRedirect({ info }: { info: { instanceId: string; path: string } }) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<'checking' | 'failed'>('checking');

  useEffect(() => {
    const instance = useInstanceStore.getState().findInstance(info.instanceId);
    if (!instance) {
      setPhase('failed');
      return;
    }
    void (async () => {
      const profile = await useAuthStore.getState().checkAuth(instance);
      if (!profile) {
        setPhase('failed');
        return;
      }
      const workspaces = await useScopeStore.getState().loadWorkspaces(instance);
      const first = workspaces[0];
      navigate(
        first
          ? buildScopePath({ instanceId: info.instanceId, workspaceId: first.id })
          : buildScopePath(LOCAL_SCOPE),
        { replace: true },
      );
    })();
  }, [info.instanceId, info.path, navigate]);

  if (phase === 'failed') {
    return (
      <MessagePage
        title="登录失败"
        message="GitHub 授权未成功，请重试。"
        action={
          <button
            type="button"
            onClick={() => navigate(buildScopePath(LOCAL_SCOPE), { replace: true })}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white"
          >
            返回项目中心
          </button>
        }
      />
    );
  }
  return <FullPageLoading />;
}

function RootRedirect() {
  // Post-OAuth redirect takes priority over the normal initial-route logic.
  const loginRedirect = useRef(consumePostLoginRedirect());
  if (loginRedirect.current) return <PostLoginRedirect info={loginRedirect.current} />;

  const status = useProjectCatalogStore((state) => state.status);
  const projects = useProjectCatalogStore((state) => state.projects);
  const createProject = useProjectCatalogStore((state) => state.createProject);
  const lastActiveRef = useProjectCatalogStore((state) => state.navigation.lastActiveRef);
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
  // Prefer the last active local project; fall back to the first project.
  const lastLocal =
    lastActiveRef &&
    lastActiveRef.instanceId === 'local' &&
    projects.some((project) => project.id === lastActiveRef.projectId)
      ? lastActiveRef
      : null;
  const target = lastLocal ?? (projects[0] ? localProjectRef(projects[0].id) : null);
  return <Navigate to={target ? buildProjectPath(target) : buildScopePath(LOCAL_SCOPE)} replace />;
}

function ProjectEditorRoute() {
  const params = useParams();
  const ref = refFromParams(params);
  const status = useProjectCatalogStore((state) => state.status);
  const projects = useProjectCatalogStore((state) => state.projects);
  const trash = useProjectCatalogStore((state) => state.trash);
  const activateProject = useProjectCatalogStore((state) => state.activateProject);
  const restoreProject = useProjectCatalogStore((state) => state.restoreProject);
  const activeProjectRef = useProjectStore((state) => state.activeProjectRef);
  const loadState = useProjectStore((state) => state.loadState);
  const saveError = useProjectStore((state) => state.lastSaveError);
  const [attemptedRef, setAttemptedRef] = useState<string | null>(null);
  const refKey = ref ? `${ref.instanceId}/${ref.workspaceId}/${ref.projectId}` : null;

  useEffect(() => {
    if (!ref || status !== 'ready') return;
    let cancelled = false;
    void activateProject(ref).finally(() => {
      if (!cancelled && refKey) setAttemptedRef(refKey);
    });
    return () => {
      cancelled = true;
    };
  }, [activateProject, refKey, status]);

  if (status === 'idle' || status === 'loading' || loadState === 'loading') {
    return <FullPageLoading />;
  }
  if (!ref) return <Navigate to={buildScopePath(LOCAL_SCOPE)} replace />;
  const projectId = ref.projectId;
  const trashedProject = trash.find((project) => project.id === projectId);
  if (trashedProject) {
    return (
      <MessagePage
        title="项目已在回收站"
        message={`“${trashedProject.name}”需要恢复后才能继续编辑。`}
        action={
          <button
            type="button"
            onClick={() => void restoreProject(ref)}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white"
          >
            恢复项目
          </button>
        }
      />
    );
  }
  const exists = projects.some((project) => project.id === projectId);
  if (attemptedRef === refKey && (!exists || loadState === 'missing')) {
    return <MessagePage title="项目不存在" message="该项目可能已经被删除或链接无效。" />;
  }
  if (attemptedRef === refKey && loadState === 'error') {
    return <MessagePage title="无法打开项目" message={saveError ?? '加载项目失败'} />;
  }
  if (
    !activeProjectRef ||
    refKey !==
      `${activeProjectRef.instanceId}/${activeProjectRef.workspaceId}/${activeProjectRef.projectId}` ||
    loadState !== 'ready'
  )
    return <FullPageLoading />;
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
            to={buildScopePath(LOCAL_SCOPE)}
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg"
          >
            返回项目中心
          </Link>
        </div>
      </div>
    </div>
  );
}
