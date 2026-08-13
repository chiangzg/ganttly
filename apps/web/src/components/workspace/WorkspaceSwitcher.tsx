/**
 * Workspace scope switcher (spec §2.2/§12.3).
 *
 * A dropdown in the project-center header that lists the local workspace and
 * all known remote instances (official + custom). Selecting a scope flushes
 * the pending save, switches the active scope, and refreshes the project list.
 *
 * Remote instances show a login indicator; clicking an unauthenticated one
 * prompts the login flow rather than switching.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Cloud, HardDrive, LogIn, Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { buildScopePath } from '@/lib/routing';
import { officialInstance, useInstanceStore } from '@/store/useInstanceStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useScopeStore, type WorkspaceSummary } from '@/store/useScopeStore';
import { useProjectCatalogStore } from '@/store/useProjectCatalogStore';
import { useProjectStore } from '@/store/useProjectStore';
import { localScope, scopeEqual, type ScopeRef } from '@/data/projectRef';
import { AddInstanceDialog } from './AddInstanceDialog';

export function WorkspaceSwitcher() {
  const [addOpen, setAddOpen] = useState(false);
  const customInstances = useInstanceStore((s) => s.customInstances);
  const activeScope = useScopeStore((s) => s.activeScope);
  const workspacesByInstance = useScopeStore((s) => s.workspacesByInstance);
  const switchScope = useScopeStore((s) => s.switchScope);
  const loadWorkspaces = useScopeStore((s) => s.loadWorkspaces);
  const authByInstance = useAuthStore((s) => s.authByInstance);
  const refresh = useProjectCatalogStore((s) => s.refresh);

  const instances = [officialInstance(), ...customInstances];
  const activeIsLocal = scopeEqual(activeScope, localScope());

  const handleSelectScope = async (scope: ScopeRef) => {
    if (scopeEqual(activeScope, scope)) return;
    const ok = await switchScope(scope, () => useProjectStore.getState().flushPendingSave());
    if (!ok) return;
    await refresh();
  };

  const handleSelectInstance = async (instanceId: string) => {
    const auth = authByInstance[instanceId];
    if (!auth) {
      // Not logged in — trigger login flow.
      const instance = instances.find((i) => i.id === instanceId);
      if (instance) {
        useAuthStore.getState().login(instance, buildScopePath({ instanceId, workspaceId: '' }));
      }
      return;
    }
    // Authenticated — load workspaces and switch to the first one.
    const instance = instances.find((i) => i.id === instanceId);
    if (!instance) return;
    const workspaces = await loadWorkspaces(instance);
    const first = workspaces[0];
    if (first) {
      await handleSelectScope({ instanceId, workspaceId: first.id });
    }
  };

  const activeLabel = activeIsLocal
    ? '本地工作区'
    : (instances.find((i) => i.id === activeScope.instanceId)?.displayName ?? '远端工作区');

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg outline-none transition hover:bg-bg focus-visible:ring-2 focus-visible:ring-primary/35"
          >
            {activeIsLocal ? <HardDrive size={16} /> : <Cloud size={16} />}
            <span className="max-w-[140px] truncate">{activeLabel}</span>
            <ChevronDown size={14} className="text-fg-muted" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            className="z-40 min-w-64 rounded-2xl border border-border bg-bg-elevated p-1.5 shadow-xl outline-none"
          >
            {/* Local workspace */}
            <DropdownMenu.Item
              onSelect={() => void handleSelectScope(localScope())}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none hover:bg-bg focus:bg-bg',
              )}
            >
              <HardDrive size={16} className="text-fg-muted" />
              <span className="flex-1 font-medium text-fg">本地工作区</span>
              <span className="text-xs text-fg-muted">此设备</span>
              {activeIsLocal ? <Check size={14} className="text-primary" /> : null}
            </DropdownMenu.Item>

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            {/* Section header */}
            <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              远端服务
            </div>

            {/* Remote instances */}
            {instances.map((instance) => {
              const workspaces: WorkspaceSummary[] = workspacesByInstance[instance.id] ?? [];
              const auth = authByInstance[instance.id];
              const isActive = activeScope.instanceId === instance.id;
              return (
                <div key={instance.id}>
                  {workspaces.length > 0 && auth ? (
                    workspaces.map((ws) => (
                      <DropdownMenu.Item
                        key={ws.id}
                        onSelect={() =>
                          void handleSelectScope({ instanceId: instance.id, workspaceId: ws.id })
                        }
                        className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm outline-none hover:bg-bg focus:bg-bg"
                      >
                        <Cloud size={16} className="text-fg-muted" />
                        <span className="flex-1 truncate font-medium text-fg">{ws.name}</span>
                        {scopeEqual(activeScope, {
                          instanceId: instance.id,
                          workspaceId: ws.id,
                        }) ? (
                          <Check size={14} className="text-primary" />
                        ) : null}
                      </DropdownMenu.Item>
                    ))
                  ) : (
                    <DropdownMenu.Item
                      onSelect={() => void handleSelectInstance(instance.id)}
                      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm outline-none hover:bg-bg focus:bg-bg"
                    >
                      <Cloud size={16} className="text-fg-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-fg">{instance.displayName}</div>
                        <div className="truncate text-xs text-fg-muted">{instance.baseUrl}</div>
                      </div>
                      {auth ? (
                        isActive ? (
                          <Check size={14} className="text-primary" />
                        ) : null
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-primary">
                          <LogIn size={12} /> 登录
                        </span>
                      )}
                    </DropdownMenu.Item>
                  )}
                </div>
              );
            })}

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <DropdownMenu.Item
              onSelect={() => setAddOpen(true)}
              className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm text-fg-muted outline-none hover:bg-bg focus:bg-bg"
            >
              <Plus size={16} />
              添加远端服务
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <AddInstanceDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}
