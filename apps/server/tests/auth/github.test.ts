import { afterEach, describe, expect, it } from 'vitest';
import {
  GITHUB_OAUTH_SCOPES,
  GITHUB_PROVIDER,
  GitHubOauthError,
  buildAuthorizeUrl,
  createDefaultGitHubDeps,
} from '../../src/auth/github';

describe('buildAuthorizeUrl', () => {
  it('builds the GitHub authorize URL with client_id, redirect, state and scopes', () => {
    const url = buildAuthorizeUrl({
      clientId: 'client_123',
      redirectUri: 'http://localhost:3001/api/v1/auth/github/callback',
      state: 'abc123',
    });
    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('client_id')).toBe('client_123');
    expect(params.get('redirect_uri')).toBe('http://localhost:3001/api/v1/auth/github/callback');
    expect(params.get('state')).toBe('abc123');
    expect(params.get('scope')).toBe(GITHUB_OAUTH_SCOPES.join(' '));
    expect(params.get('allow_signup')).toBe('true');
  });

  it('uses GitHub as the stored provider identifier', () => {
    expect(GITHUB_PROVIDER).toBe('https://github.com');
  });
});

describe('createDefaultGitHubDeps', () => {
  const originalFetch = globalThis.fetch;

  function mockFetch(tokenResponse: unknown, userResponse: unknown, userOk = true, tokenOk = true) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push({ url: urlStr, init });
      const body = urlStr.includes('access_token') ? tokenResponse : userResponse;
      const ok = urlStr.includes('access_token') ? tokenOk : userOk;
      return { ok, status: ok ? 200 : 401, json: async () => body } as Response;
    }) as typeof fetch;
    return calls;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('exchanges a code for an access token and fetches the user', async () => {
    const calls = mockFetch(
      { access_token: 'tok_1', token_type: 'bearer', scope: 'read:user' },
      { id: 42, login: 'octocat', name: 'The Octocat', email: null, avatar_url: 'u' },
    );
    const deps = createDefaultGitHubDeps('cid', 'secret');
    const token = await deps.exchangeCode('code1', 'http://cb');
    expect(token).toBe('tok_1');
    const user = await deps.fetchUser('tok_1');
    expect(user).toEqual({
      id: 42,
      login: 'octocat',
      name: 'The Octocat',
      email: null,
      avatar_url: 'u',
    });
    // Token request carries the client secret + Accept JSON.
    const tokenCall = calls.find((c) => c.url.includes('access_token'));
    expect(tokenCall?.init?.method).toBe('POST');
    const tokenBody = JSON.parse(String(tokenCall?.init?.body));
    expect(tokenBody).toMatchObject({
      client_id: 'cid',
      client_secret: 'secret',
      code: 'code1',
    });
  });

  it('throws GitHubOauthError when the token endpoint returns no access_token', async () => {
    mockFetch({ error: 'bad_verification_code' }, {});
    const deps = createDefaultGitHubDeps('cid', 'secret');
    await expect(deps.exchangeCode('bad', 'http://cb')).rejects.toBeInstanceOf(GitHubOauthError);
  });

  it('throws GitHubOauthError when GET /user fails', async () => {
    mockFetch({ access_token: 'tok' }, {}, false);
    const deps = createDefaultGitHubDeps('cid', 'secret');
    await expect(deps.fetchUser('tok')).rejects.toBeInstanceOf(GitHubOauthError);
  });
});
