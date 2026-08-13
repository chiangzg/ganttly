/**
 * GitHub OAuth (OAuth App) — hand-written confidential-client flow (spec §8.2,
 * §0 decision 3).
 *
 * GitHub is not a standard OIDC provider (no id_token / discovery / userinfo),
 * so we exchange the authorization code for an access token and read identity
 * from `GET /user`, then discard the token. The network calls are isolated
 * behind {@link GitHubOAuthDeps} so tests inject fakes without touching global
 * `fetch`.
 *
 * We use an OAuth App (scopes `read:user` + `user:email`), not a GitHub App:
 * ganttly needs identity only and never touches GitHub resources, so GitHub
 * App fine-grained permissions / expiring tokens / installation friction would
 * be pure overhead.
 */

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

/** Scopes requested for an OAuth App: public profile (+ private email). */
export const GITHUB_OAUTH_SCOPES = ['read:user', 'user:email'] as const;

/** Subset of `GET /user` we persist. `id` becomes our `subject`. */
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export class GitHubOauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubOauthError';
  }
}

export interface BuildAuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  allowSignup?: boolean;
}

/** Build the GitHub authorization URL (OAuth App web flow). Pure. */
export function buildAuthorizeUrl(options: BuildAuthorizeUrlOptions): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    scope: (options.scopes ?? GITHUB_OAUTH_SCOPES).join(' '),
    allow_signup: String(options.allowSignup ?? true),
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Injectable network surface for the OAuth flow. The default implementation
 * uses global `fetch`; tests pass a fake to avoid hitting GitHub.
 */
export interface GitHubOAuthDeps {
  /** Exchange an authorization code for a user access token. */
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  /** Fetch the authenticated user's identity. */
  fetchUser(accessToken: string): Promise<GitHubUser>;
}

export function createDefaultGitHubDeps(clientId: string, clientSecret: string): GitHubOAuthDeps {
  return {
    async exchangeCode(code, redirectUri) {
      const res = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!res.ok) {
        throw new GitHubOauthError(`GitHub token endpoint returned ${res.status}`);
      }
      const data = (await res.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!data.access_token) {
        throw new GitHubOauthError(
          `GitHub token exchange failed: ${data.error ?? 'unknown'}${
            data.error_description ? ` — ${data.error_description}` : ''
          }`,
        );
      }
      return data.access_token;
    },
    async fetchUser(accessToken) {
      const res = await fetch(GITHUB_USER_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) {
        throw new GitHubOauthError(`GitHub GET /user returned ${res.status}`);
      }
      return (await res.json()) as GitHubUser;
    },
  };
}

/**
 * The provider string stored in `users.provider` for GitHub identities
 * (spec §0 decision 3). A full URL keeps the door open for future OIDC
 * issuers (stored as their issuer URL) as a non-breaking extension.
 */
export const GITHUB_PROVIDER = 'https://github.com';
