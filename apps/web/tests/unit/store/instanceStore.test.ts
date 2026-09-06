import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  officialInstance,
  useInstanceStore,
  InstanceDiscoveryError,
} from '@/store/useInstanceStore';

function discoveryPayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    protocol: 'ganttly-instance',
    protocolVersion: '1',
    instanceId: 'inst_custom1',
    displayName: 'Self-hosted',
    baseUrl: 'https://gan.internal',
    apiBaseUrl: 'https://gan.internal/api/v1',
    webAppUrl: 'https://gan.internal',
    mcp: { url: 'https://gan.internal/mcp', transport: 'streamable-http', authMethods: ['pat'] },
    auth: { browserModes: ['session'], providers: ['github'] },
    events: { transport: 'sse', url: 'https://gan.internal/api/v1/events' },
    apiVersions: ['v1'],
    minClientVersion: '0.1.0',
    features: { projectImport: true, mcp: true, sse: true, teamWorkspaces: false },
    ...overrides,
  };
}

describe('useInstanceStore', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  /**
   * Route the fetch mock by URL + request shape: the discovery read carries an
   * `Accept` header, the reachability probe is `mode: 'no-cors'` (same URL),
   * and the credentialed CORS probe hits `<apiBaseUrl>/me`. Throwing simulates
   * the browser rejecting the response (CORS block / network failure).
   */
  function mockDiscoveryAndProbe(
    payload: Record<string, unknown> = discoveryPayload(),
    opts: {
      discovery?: 'ok' | 'blocked';
      reachability?: 'ok' | 'down';
      probe?: 'ok' | 'blocked';
    } = {},
  ): void {
    const { discovery = 'ok', reachability = 'ok', probe = 'ok' } = opts;
    fetchSpy.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/.well-known/ganttly-instance')) {
        if (init?.mode === 'no-cors') {
          if (reachability === 'down') throw new TypeError('Failed to fetch');
          return new Response(null);
        }
        if (discovery === 'blocked') throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (probe === 'blocked') throw new TypeError('Failed to fetch');
      return new Response(null, { status: 401 });
    });
  }

  beforeEach(() => {
    localStorage.clear();
    useInstanceStore.setState({ customInstances: [] });
    fetchSpy.mockReset();
  });
  afterEach(() => fetchSpy.mockReset());

  describe('officialInstance', () => {
    it('is always present and same-origin', () => {
      const official = officialInstance();
      expect(official.kind).toBe('official');
      expect(official.id).toBe('official');
    });
  });

  describe('instances()', () => {
    it('returns official first, then custom', () => {
      useInstanceStore.setState({
        customInstances: [{ id: 'c1', displayName: 'C', baseUrl: 'https://c', kind: 'custom' }],
      });
      const list = useInstanceStore.getState().instances();
      expect(list[0]!.id).toBe('official');
      expect(list[1]!.id).toBe('c1');
    });
  });

  describe('addCustomInstance', () => {
    it('fetches discovery, probes credentialed CORS, and stores the instance', async () => {
      mockDiscoveryAndProbe();
      const config = await useInstanceStore.getState().addCustomInstance('https://gan.internal/');
      expect(config.id).toBe('inst_custom1');
      expect(config.displayName).toBe('Self-hosted');
      // Second call is the credentialed probe against the advertised apiBaseUrl.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1]).toEqual([
        'https://gan.internal/api/v1/me',
        { credentials: 'include' },
      ]);
      expect(useInstanceStore.getState().customInstances).toHaveLength(1);
      // Persisted to localStorage.
      const stored = JSON.parse(localStorage.getItem('ganttly:instances')!) as Array<{
        id: string;
      }>;
      expect(stored[0]!.id).toBe('inst_custom1');
    });

    it('rejects non-HTTPS (non-loopback) URLs', async () => {
      await expect(
        useInstanceStore.getState().addCustomInstance('http://example.com'),
      ).rejects.toThrow(InstanceDiscoveryError);
    });

    it('allows localhost over HTTP (dev exception)', async () => {
      mockDiscoveryAndProbe(discoveryPayload({ instanceId: 'inst_local' }));
      const config = await useInstanceStore.getState().addCustomInstance('http://localhost:3000');
      expect(config.id).toBe('inst_local');
    });

    it('rejects when discovery returns incompatible protocol', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ protocol: 'something-else' }), { status: 200 }),
      );
      await expect(
        useInstanceStore.getState().addCustomInstance('https://gan.internal'),
      ).rejects.toThrow(InstanceDiscoveryError);
    });

    it('rejects when the credentialed CORS probe is blocked', async () => {
      mockDiscoveryAndProbe(discoveryPayload(), { probe: 'blocked' });
      await expect(
        useInstanceStore.getState().addCustomInstance('https://gan.internal'),
      ).rejects.toThrow(/ALLOWED_WEB_ORIGINS/);
      // Nothing is registered — the instance would be unusable.
      expect(useInstanceStore.getState().customInstances).toHaveLength(0);
    });

    it('tells a reachable-but-CORS-blocked instance apart from an unreachable one', async () => {
      // Old ganttly server (or missing ALLOWED_WEB_ORIGINS): the discovery
      // response is CORS-blocked, but the host itself answers.
      mockDiscoveryAndProbe(discoveryPayload(), { discovery: 'blocked' });
      await expect(
        useInstanceStore.getState().addCustomInstance('https://gan.internal'),
      ).rejects.toThrow(/拦截了它的跨域响应/);

      // Genuinely unreachable: the no-cors reachability probe fails too.
      mockDiscoveryAndProbe(discoveryPayload(), { discovery: 'blocked', reachability: 'down' });
      await expect(
        useInstanceStore.getState().addCustomInstance('https://gan.internal'),
      ).rejects.toThrow('无法连接到该地址，请检查 URL');
      expect(useInstanceStore.getState().customInstances).toHaveLength(0);
    });

    it('rejects duplicates before probing again', async () => {
      mockDiscoveryAndProbe();
      await useInstanceStore.getState().addCustomInstance('https://gan.internal');
      await expect(
        useInstanceStore.getState().addCustomInstance('https://gan2.internal'),
      ).rejects.toThrow(InstanceDiscoveryError);
      expect(fetchSpy).toHaveBeenCalledTimes(2 + 1);
    });
  });

  describe('removeCustomInstance', () => {
    it('removes by id', async () => {
      mockDiscoveryAndProbe();
      await useInstanceStore.getState().addCustomInstance('https://gan.internal');
      useInstanceStore.getState().removeCustomInstance('inst_custom1');
      expect(useInstanceStore.getState().customInstances).toHaveLength(0);
    });
  });
});
