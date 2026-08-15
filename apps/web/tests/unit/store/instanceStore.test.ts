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
    it('fetches discovery, validates, and stores the instance', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(discoveryPayload()), { status: 200 }));
      const config = await useInstanceStore.getState().addCustomInstance('https://gan.internal/');
      expect(config.id).toBe('inst_custom1');
      expect(config.displayName).toBe('Self-hosted');
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
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify(discoveryPayload({ instanceId: 'inst_local' })), {
          status: 200,
        }),
      );
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

    it('rejects duplicates', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(discoveryPayload()), { status: 200 }));
      await useInstanceStore.getState().addCustomInstance('https://gan.internal');
      await expect(
        useInstanceStore.getState().addCustomInstance('https://gan2.internal'),
      ).rejects.toThrow(InstanceDiscoveryError);
    });
  });

  describe('removeCustomInstance', () => {
    it('removes by id', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(discoveryPayload()), { status: 200 }));
      await useInstanceStore.getState().addCustomInstance('https://gan.internal');
      useInstanceStore.getState().removeCustomInstance('inst_custom1');
      expect(useInstanceStore.getState().customInstances).toHaveLength(0);
    });
  });
});
