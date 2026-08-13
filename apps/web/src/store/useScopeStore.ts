/**
 * Active scope + per-instance workspace list (spec §12.1).
 *
 * The scope is the `(instanceId, workspaceId)` pair that determines which
 * project list the project center shows and which repository create/save
 * operations target. Local mode is the default scope `{ local, local }`.
 *
 * Switching scope flushes the currently active project's pending save first
 * (spec §12.3); if the flush fails the switch is aborted so the user never
 * loses unsaved work.
 */
import { create } from 'zustand';
import type { InstanceConfig } from './useInstanceStore';
import { localScope, scopeEqual, type ScopeRef } from '@/data/projectRef';

export interface WorkspaceSummary {
  id: string;
  instanceId: string;
  name: string;
  kind: 'personal' | 'team';
  role: 'owner' | 'admin' | 'editor' | 'viewer';
}

interface WorkspacesResponse {
  workspaces: Array<{ id: string; name: string; kind: 'personal' | 'team'; role: string }>;
}

interface ScopeState {
  activeScope: ScopeRef;
  workspacesByInstance: Record<string, WorkspaceSummary[]>;
  /** Loading flag per instance — avoids double-fetching workspace lists. */
  loadingInstances: Set<string>;

  switchScope(scope: ScopeRef, flush?: () => Promise<void>): Promise<boolean>;
  loadWorkspaces(instance: InstanceConfig): Promise<WorkspaceSummary[]>;
  getWorkspaces(instanceId: string): WorkspaceSummary[];
  resetToLocal(): void;
}

export const useScopeStore = create<ScopeState>((set, get) => ({
  activeScope: localScope(),
  workspacesByInstance: {},
  loadingInstances: new Set<string>(),

  async switchScope(scope, flush) {
    if (scopeEqual(get().activeScope, scope)) return true;
    // Flush the pending save so no work is lost on scope change (spec §12.3).
    if (flush) {
      try {
        await flush();
      } catch {
        // Save failed — abort the switch.
        return false;
      }
    }
    set({ activeScope: scope });
    return true;
  },

  async loadWorkspaces(instance) {
    if (get().loadingInstances.has(instance.id)) return get().getWorkspaces(instance.id);
    set((state) => ({ loadingInstances: state.loadingInstances.add(instance.id) as Set<string> }));

    const baseUrl = instance.baseUrl.replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/api/v1/workspaces`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        set((state) => {
          const loading = new Set(state.loadingInstances);
          loading.delete(instance.id);
          return { loadingInstances: loading };
        });
        return [];
      }
      const data = (await response.json()) as WorkspacesResponse;
      const workspaces: WorkspaceSummary[] = data.workspaces.map((ws) => ({
        id: ws.id,
        instanceId: instance.id,
        name: ws.name,
        kind: ws.kind,
        role: ws.role as WorkspaceSummary['role'],
      }));
      set((state) => {
        const loading = new Set(state.loadingInstances);
        loading.delete(instance.id);
        return {
          workspacesByInstance: { ...state.workspacesByInstance, [instance.id]: workspaces },
          loadingInstances: loading,
        };
      });
      return workspaces;
    } catch {
      set((state) => {
        const loading = new Set(state.loadingInstances);
        loading.delete(instance.id);
        return { loadingInstances: loading };
      });
      return [];
    }
  },

  getWorkspaces(instanceId) {
    return get().workspacesByInstance[instanceId] ?? [];
  },

  resetToLocal() {
    set({ activeScope: localScope() });
  },
}));
