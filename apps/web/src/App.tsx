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
import { LoginGate } from './components/workspace/LoginGate';
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
import { isLocalRef } from './data/projectRef';
import { useProjectCatalogStore } from './store/useProjectCatalogStore';
import { useProjectStore } from './store/useProjectStore';
import { useInstanceStore } from './store/useInstanceStore';
import { useAuthStore, consumePostLoginRedirect, loginErrorMessage } from './store/useAuthStore';
import { useScopeStore } from './store/useScopeStore';

export function App() {
  const init = useProjectCatalogStore((state) => state.init);
  const dirty = useProjectStore((state) => state.dirty);

  // Consume `?login_error=` during the first render, before any route mounts:
  // OAuth failures land on `/` and RootRedirect/PostLoginRedirect navigate
  // away in their own effects, which would rewrite the URL first. The lazy
  // initializer runs once per App mount, mirroring RootRedirect's
  // `useRef(consumePostLoginRedirect())` pattern.
  useState(() => {
    useAuthStore.getState().captureLoginError();
    return null;
  });

  useEffect(() => {
    // Guard on the repository rather than `status === 'idle'`: a refresh that
    // races ahead of this effect (child effects run before parent effects)
    // can set status to 'error' before init ever runs, and the old guard
    // would then skip initialization forever — leaving the local workspace
    // stuck on "工作区未登录或不可用" until the app is reloaded from `/`.
    if (!useProjectCatalogStore.getState().repo) void init(getRepository());
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
  // Specific reason when the server reported one via `?login_error=`
  // (e.g. an allowlist denial); null keeps the generic retry copy.
  const [failedMessage, setFailedMessage] = useState<string | null>(null);

  useEffect(() => {
    const instance = useInstanceStore.getState().findInstance(info.instanceId);
    if (!instance) {
      setPhase('failed');
      return;
    }
    void (async () => {
      const profile = await useAuthStore.getState().checkAuth(instance);
      if (!profile) {
        // Consume the stashed code so a stale reason doesn't resurface in a
        // later LoginGate mount.
        setFailedMessage(loginErrorMessage(useAuthStore.getState().consumeLoginError()));
        setPhase('failed');
        return;
      }
      // Honor the stashed deep link (project editor path, workspace center)
      // so logging in from a deep page returns there; bare "/" keeps the
      // legacy first-workspace fallback below.
      if (info.path && info.path !== '/') {
        navigate(info.path, { replace: true });
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
        message={failedMessage ?? 'GitHub 授权未成功，请重试。'}
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
  // Tri-state auth for remote refs: undefined = no checkAuth resolved yet in
  // this session (the auth store is memory-only), null = checked but logged
  // out, object = signed in. Subscribe to authByInstance rather than
  // `checked` — the 401 path mutates that Set in place, so a `checked`
  // selector would miss the update.
  const remoteProfile = useAuthStore((state) =>
    ref && !isLocalRef(ref) ? state.authByInstance[ref.instanceId] : null,
  );
  const [attemptedRef, setAttemptedRef] = useState<string | null>(null);
  const [instanceMissing, setInstanceMissing] = useState(false);
  const refKey = ref ? `${ref.instanceId}/${ref.workspaceId}/${ref.projectId}` : null;
  const isRemote = Boolean(ref && !isLocalRef(ref));

  useEffect(() => {
    if (!ref || status !== 'ready') return;
    if (isLocalRef(ref)) {
      let cancelled = false;
      void activateProject(ref).finally(() => {
        if (!cancelled && refKey) setAttemptedRef(refKey);
      });
      return () => {
        cancelled = true;
      };
    }
    const instance = useInstanceStore.getState().findInstance(ref.instanceId);
    if (!instance) {
      setInstanceMissing(true);
      return;
    }
    // A deep link skips the project center's LoginGate, and the auth store is
    // memory-only — so on a fresh reload the session must be re-checked here
    // before the first load attempt, otherwise loadProject resolves no
    // repository and this route would spin forever. The store update flips
    // `remoteProfile`, which re-runs this effect.
    if (remoteProfile === undefined) {
      void useAuthStore.getState().checkAuth(instance);
      return;
    }
    if (!remoteProfile) return; // checked and logged out — render LoginGate below
    let cancelled = false;
    void activateProject(ref).finally(() => {
      if (!cancelled && refKey) setAttemptedRef(refKey);
    });
    return () => {
      cancelled = true;
    };
  }, [activateProject, refKey, status, remoteProfile]);

  if (status === 'idle' || status === 'loading' || loadState === 'loading') {
    return <FullPageLoading />;
  }
  if (!ref) return <Navigate to={buildScopePath(LOCAL_SCOPE)} replace />;
  if (isRemote && instanceMissing) {
    return (
      <MessagePage
        title="实例不可用"
        message="链接指向的远端服务不在实例列表中，请从项目中心重新进入。"
      />
    );
  }
  if (isRemote && remoteProfile === undefined) {
    return <FullPageLoading />;
  }
  if (isRemote && remoteProfile === null) {
    return (
      <div className="flex h-full flex-col">
        <LoginGate instanceId={ref.instanceId} returnTo={buildProjectPath(ref)} />
      </div>
    );
  }
  const projectId = ref.projectId;
  // The catalog list/trash reflect the *active* scope (usually local on a
  // fresh load). For remote deep links they are irrelevant — and checking a
  // local id against them could hide a valid remote project or let a local
  // trashed project hijack a remote view — so gate both checks to local refs
  // and rely on `loadState` for remote refs.
  const trashedProject = isLocalRef(ref)
    ? trash.find((project) => project.id === projectId)
    : undefined;
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
  // Remote existence is answered by loadProject/loadState, not the (possibly
  // local-scoped) catalog list.
  const exists = isLocalRef(ref) ? projects.some((project) => project.id === projectId) : true;
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
