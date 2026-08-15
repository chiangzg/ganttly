/**
 * Instance registry — the set of known ganttly servers (spec §2.2/§12.1).
 *
 * The official instance is built-in (same-origin, not removable). Self-hosted
 * instances are added by the user via the workspace switcher: the URL is
 * confirmed against the public `/.well-known/ganttly-instance` discovery
 * descriptor before it enters the registry.
 *
 * Persisted to `localStorage` under `ganttly:instances`.
 */
import { create } from 'zustand';
import { instanceDiscoverySchema, type InstanceDiscovery } from '@ganttly/api-contract';

export interface InstanceConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  kind: 'official' | 'custom';
}

const STORAGE_KEY = 'ganttly:instances';

/** Same-origin origin, lazily computed (SSR-safe). */
function currentOrigin(): string {
  if (typeof window !== 'undefined') return window.location.origin;
  return 'http://localhost:5173';
}

/** The built-in official instance — always present, same-origin. */
export function officialInstance(): InstanceConfig {
  const origin = currentOrigin();
  return {
    id: 'official',
    displayName: 'ganttly Cloud',
    baseUrl: origin,
    kind: 'official',
  };
}

/**
 * Fetch + validate a live instance's discovery descriptor. Returns null on
 * any failure (unreachable, non-200, contract mismatch) — callers fall back
 * to their existing flow instead of crashing. Unlike {@link
 * InstanceState.addCustomInstance} this never mutates the registry.
 */
export async function fetchInstanceDiscovery(
  instance: Pick<InstanceConfig, 'baseUrl'>,
): Promise<InstanceDiscovery | null> {
  const baseUrl = instance.baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${baseUrl}/.well-known/ganttly-instance`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const parsed = instanceDiscoverySchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface InstanceState {
  customInstances: InstanceConfig[];
  /** All known instances: official first, then custom. */
  instances(): InstanceConfig[];
  findInstance(id: string): InstanceConfig | undefined;
  addCustomInstance(url: string): Promise<InstanceConfig>;
  removeCustomInstance(id: string): void;
}

function loadCustom(): InstanceConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as InstanceConfig[];
    return Array.isArray(parsed) ? parsed.filter((i) => i && i.id && i.baseUrl) : [];
  } catch {
    return [];
  }
}

function persistCustom(instances: InstanceConfig[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(instances));
  } catch {
    // ignore
  }
}

/** Normalise a user-entered URL: trim, strip trailing slash, upgrade to https. */
function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new InstanceDiscoveryError('地址不能为空');
  // Upgrade bare `example.com` to `https://example.com`.
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

export class InstanceDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceDiscoveryError';
  }
}

export const useInstanceStore = create<InstanceState>((set, get) => ({
  customInstances: loadCustom(),

  instances() {
    return [officialInstance(), ...get().customInstances];
  },

  findInstance(id) {
    return get()
      .instances()
      .find((i) => i.id === id);
  },

  async addCustomInstance(url) {
    const normalized = normalizeUrl(url);
    // Spec §2.2: localhost / loopback is a dev exception; otherwise HTTPS required.
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(normalized);
    if (!isLoopback && !normalized.startsWith('https://')) {
      throw new InstanceDiscoveryError('远端服务地址必须是 HTTPS');
    }

    let discovery: InstanceDiscovery;
    try {
      const response = await fetch(`${normalized}/.well-known/ganttly-instance`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new InstanceDiscoveryError(`发现服务失败 (HTTP ${response.status})`);
      }
      const json = (await response.json()) as unknown;
      const parsed = instanceDiscoverySchema.safeParse(json);
      if (!parsed.success) {
        throw new InstanceDiscoveryError('服务协议不兼容或响应格式无效');
      }
      discovery = parsed.data;
    } catch (err) {
      if (err instanceof InstanceDiscoveryError) throw err;
      throw new InstanceDiscoveryError('无法连接到该地址，请检查 URL');
    }

    // De-duplicate: if the same instanceId is already registered, reject.
    const existing = get().instances();
    if (existing.some((i) => i.id === discovery.instanceId)) {
      throw new InstanceDiscoveryError('该实例已添加');
    }

    const config: InstanceConfig = {
      id: discovery.instanceId,
      displayName: discovery.displayName,
      baseUrl: normalized,
      kind: 'custom',
    };
    const next = [...get().customInstances, config];
    set({ customInstances: next });
    persistCustom(next);
    return config;
  },

  removeCustomInstance(id) {
    const next = get().customInstances.filter((i) => i.id !== id);
    set({ customInstances: next });
    persistCustom(next);
  },
}));
