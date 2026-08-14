import { describe, expect, it } from 'vitest';
import {
  instanceDiscoverySchema,
  INSTANCE_PROTOCOL,
  INSTANCE_PROTOCOL_VERSION,
  INSTANCE_WELL_KNOWN_PATH,
  buildApiError,
  errorCodeToStatus,
  ApiErrorCode,
  DEFAULT_LIMITS,
} from '../src';

describe('instance discovery schema', () => {
  it('parses a complete valid descriptor', () => {
    const result = instanceDiscoverySchema.parse({
      protocol: INSTANCE_PROTOCOL,
      protocolVersion: INSTANCE_PROTOCOL_VERSION,
      instanceId: 'inst_official',
      displayName: 'ganttly Cloud',
      baseUrl: 'https://cloud.ganttly.com',
      apiBaseUrl: 'https://cloud.ganttly.com/api/v1',
      webAppUrl: 'https://app.ganttly.com',
      mcp: {
        url: 'https://cloud.ganttly.com/mcp',
        transport: 'streamable-http',
        authMethods: ['pat'],
      },
      auth: { browserModes: ['session'], providers: ['github'] },
      events: { transport: 'sse', url: 'https://cloud.ganttly.com/api/v1/events' },
      apiVersions: ['v1'],
      minClientVersion: '0.6.0',
      features: { projectImport: true, mcp: true, sse: true, teamWorkspaces: false },
    });
    expect(result.instanceId).toBe('inst_official');
    expect(result.mcp.transport).toBe('streamable-http');
  });

  it('rejects a non-https-looking baseUrl (must be a valid URL)', () => {
    expect(() =>
      instanceDiscoverySchema.parse({
        protocol: INSTANCE_PROTOCOL,
        protocolVersion: INSTANCE_PROTOCOL_VERSION,
        instanceId: 'x',
        displayName: 'x',
        baseUrl: 'not-a-url',
        apiBaseUrl: 'https://x/api/v1',
        webAppUrl: 'https://x',
        mcp: { url: 'https://x/mcp', transport: 'streamable-http', authMethods: ['pat'] },
        auth: { browserModes: ['session'], providers: [] },
        events: { transport: 'sse', url: 'https://x/api/v1/events' },
        apiVersions: ['v1'],
        minClientVersion: '0.6.0',
        features: { projectImport: true, mcp: true, sse: true, teamWorkspaces: false },
      }),
    ).toThrow();
  });

  it('exposes the well-known path constant', () => {
    expect(INSTANCE_WELL_KNOWN_PATH).toBe('/.well-known/ganttly-instance');
  });
});

describe('error contract', () => {
  it('maps every code to the spec HTTP status', () => {
    expect(errorCodeToStatus[ApiErrorCode.AUTH_REQUIRED]).toBe(401);
    expect(errorCodeToStatus[ApiErrorCode.FORBIDDEN]).toBe(403);
    expect(errorCodeToStatus[ApiErrorCode.NOT_FOUND]).toBe(404);
    expect(errorCodeToStatus[ApiErrorCode.VALIDATION_FAILED]).toBe(422);
    expect(errorCodeToStatus[ApiErrorCode.IDEMPOTENCY_CONFLICT]).toBe(409);
    expect(errorCodeToStatus[ApiErrorCode.REVISION_CONFLICT]).toBe(412);
    expect(errorCodeToStatus[ApiErrorCode.LIMIT_EXCEEDED]).toBe(413);
    expect(errorCodeToStatus[ApiErrorCode.RATE_LIMITED]).toBe(429);
    expect(errorCodeToStatus[ApiErrorCode.UNSUPPORTED_CLIENT]).toBe(426);
  });

  it('builds a spec-compliant body, omitting details when absent', () => {
    const without = buildApiError(ApiErrorCode.NOT_FOUND, 'missing', 'req_1');
    expect(without).toEqual({
      error: { code: 'NOT_FOUND', message: 'missing', requestId: 'req_1' },
    });
    expect('details' in without.error).toBe(false);

    const withDetails = buildApiError(ApiErrorCode.VALIDATION_FAILED, 'bad', 'req_2', {
      field: 'name',
    });
    expect(withDetails.error.details).toEqual({ field: 'name' });
  });
});

describe('document limits', () => {
  it('matches spec §9.4 defaults', () => {
    expect(DEFAULT_LIMITS.maxProjectBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_LIMITS.maxProjectTasks).toBe(10_000);
    expect(DEFAULT_LIMITS.maxBatchCreateTasks).toBe(100);
    expect(DEFAULT_LIMITS.maxMcpResponseBytes).toBe(1024 * 1024);
  });
});
