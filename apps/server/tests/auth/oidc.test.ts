import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  createDefaultOidcDeps,
  discoveryDocumentUrl,
  normalizeIssuerUrl,
  OidcError,
  oidcProviderId,
} from '../../src/auth/oidc';

const ISSUER = 'https://auth.example.com/application/o/ganttly/';

const DISCOVERY_DOC = {
  issuer: ISSUER,
  authorization_endpoint: 'https://auth.example.com/application/o/authorize/',
  token_endpoint: 'https://auth.example.com/application/o/token/',
  userinfo_endpoint: 'https://auth.example.com/application/o/userinfo/',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeIssuerUrl / oidcProviderId', () => {
  it('trims whitespace and strips trailing slashes', () => {
    expect(normalizeIssuerUrl('  https://auth.example.com/app/  ')).toBe(
      'https://auth.example.com/app',
    );
    expect(normalizeIssuerUrl('https://auth.example.com/app///')).toBe(
      'https://auth.example.com/app',
    );
  });

  it('uses the normalized issuer as the users.provider value', () => {
    expect(oidcProviderId(`${ISSUER}/`)).toBe(ISSUER.replace(/\/+$/, ''));
  });
});

describe('discoveryDocumentUrl', () => {
  it('appends the well-known path under the normalized issuer', () => {
    expect(discoveryDocumentUrl(ISSUER)).toBe(
      'https://auth.example.com/application/o/ganttly/.well-known/openid-configuration',
    );
  });
});

describe('buildAuthorizeUrl', () => {
  it('encodes the authorization-code request parameters', () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: DISCOVERY_DOC.authorization_endpoint,
      clientId: 'cid',
      redirectUri: 'http://localhost:3001/api/v1/auth/oidc/callback',
      state: 'abc123',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(DISCOVERY_DOC.authorization_endpoint);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3001/api/v1/auth/oidc/callback',
    );
    expect(parsed.searchParams.get('state')).toBe('abc123');
    expect(parsed.searchParams.get('scope')).toBe('openid profile email');
  });

  it('honours custom scopes', () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: DISCOVERY_DOC.authorization_endpoint,
      clientId: 'cid',
      redirectUri: 'http://localhost:3001/cb',
      state: 's',
      scopes: ['openid', 'groups'],
    });
    expect(new URL(url).searchParams.get('scope')).toBe('openid groups');
  });
});

describe('createDefaultOidcDeps', () => {
  it('fetches the discovery document once and caches it', async () => {
    const fetchMock = vi.fn(async (_input: unknown) => jsonResponse(200, DISCOVERY_DOC));
    vi.stubGlobal('fetch', fetchMock);
    const deps = createDefaultOidcDeps(ISSUER, 'cid', 'secret');

    const first = await deps.discoverEndpoints();
    const second = await deps.discoverEndpoints();
    expect(first).toEqual({
      authorizationEndpoint: DISCOVERY_DOC.authorization_endpoint,
      tokenEndpoint: DISCOVERY_DOC.token_endpoint,
      userinfoEndpoint: DISCOVERY_DOC.userinfo_endpoint,
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(discoveryDocumentUrl(ISSUER));
  });

  it('throws OidcError when the discovery document is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, {})),
    );
    const deps = createDefaultOidcDeps(ISSUER, 'cid', 'secret');
    await expect(deps.discoverEndpoints()).rejects.toThrow(OidcError);
  });

  it('throws OidcError when the discovery document lacks endpoints', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { issuer: ISSUER, token_endpoint: 'https://x/token' })),
    );
    const deps = createDefaultOidcDeps(ISSUER, 'cid', 'secret');
    await expect(deps.discoverEndpoints()).rejects.toThrow(/authorizationEndpoint/);
  });

  it('exchanges the code via client_secret_post form body', async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return jsonResponse(200, DISCOVERY_DOC);
      }
      expect(url).toBe(DISCOVERY_DOC.token_endpoint);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        'content-type': 'application/x-www-form-urlencoded',
      });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('the-code');
      expect(body.get('client_id')).toBe('cid');
      expect(body.get('client_secret')).toBe('secret');
      expect(body.get('redirect_uri')).toBe('http://localhost:3001/cb');
      return jsonResponse(200, { access_token: 'at-1', token_type: 'Bearer' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createDefaultOidcDeps(ISSUER, 'cid', 'secret');

    await expect(deps.exchangeCode('the-code', 'http://localhost:3001/cb')).resolves.toBe('at-1');
  });

  it('throws OidcError when the token endpoint returns an error payload', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return jsonResponse(200, DISCOVERY_DOC);
      }
      return jsonResponse(200, { error: 'invalid_grant', error_description: 'code expired' });
    });
    const deps = createDefaultOidcDeps(ISSUER, 'cid', 'secret');
    await expect(deps.exchangeCode('bad', 'http://localhost:3001/cb')).rejects.toThrow(
      /invalid_grant/,
    );
  });

  it('reads identity from the userinfo endpoint and tolerates missing claims', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return jsonResponse(200, DISCOVERY_DOC);
      }
      expect(url).toBe(DISCOVERY_DOC.userinfo_endpoint);
      return jsonResponse(200, { sub: 'uuid-1', preferred_username: 'alice' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createDefaultOidcDeps(ISSUER, 'cid', 'secret');

    const user = await deps.fetchUser('at-1');
    expect(user).toEqual({
      sub: 'uuid-1',
      name: null,
      preferred_username: 'alice',
      email: null,
    });
  });

  it('throws OidcError when userinfo has no `sub` claim', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return jsonResponse(200, DISCOVERY_DOC);
      }
      return jsonResponse(200, { email: 'a@example.com' });
    });
    const deps = createDefaultOidcDeps(ISSUER, 'cid', 'secret');
    await expect(deps.fetchUser('at-1')).rejects.toThrow(/sub/);
  });
});
