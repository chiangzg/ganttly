/**
 * OIDC (OpenID Connect) — hand-written confidential-client authorization-code
 * flow (spec §8.2). Replaces the previous hand-written GitHub OAuth App flow;
 * any standards-compliant issuer works (authentik, Keycloak, …) — the issuer is
 * pure configuration (`OIDC_ISSUER_URL` + client credentials).
 *
 * Endpoints come from the issuer's discovery document
 * (`{issuer}/.well-known/openid-configuration`), fetched lazily on first login
 * and cached per process: a flaky IdP must never block server startup. We
 * request `openid profile email`, exchange the code at the token endpoint
 * (client_secret_post), read identity from the userinfo endpoint, then discard
 * the token — a basic client on par with the previous GitHub flow (no id_token
 * verification, no PKCE; access to the instance is gated at the IdP).
 */

/** Endpoints resolved from the issuer's discovery document. */
export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
}

/** Default scopes — identity only, no offline access. */
export const OIDC_DEFAULT_SCOPES = 'openid profile email';

/** Subset of the userinfo claims we persist. `sub` becomes our `subject`. */
export interface OidcUser {
  sub: string;
  name: string | null;
  preferred_username: string | null;
  email: string | null;
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

/** Trim and strip trailing slashes so issuer config drift cannot fork identities. */
export function normalizeIssuerUrl(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

/** Discovery document URL for an issuer. */
export function discoveryDocumentUrl(issuer: string): string {
  return `${normalizeIssuerUrl(issuer)}/.well-known/openid-configuration`;
}

export interface BuildAuthorizeUrlOptions {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}

/** Build the issuer's authorization URL (authorization-code web flow). Pure. */
export function buildAuthorizeUrl(options: BuildAuthorizeUrlOptions): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    scope: (options.scopes ?? OIDC_DEFAULT_SCOPES.split(' ')).join(' '),
  });
  return `${options.authorizationEndpoint}?${params.toString()}`;
}

/**
 * Injectable network surface for the OIDC flow. The default implementation
 * uses global `fetch`; tests pass a fake to avoid hitting a real issuer.
 */
export interface OidcOAuthDeps {
  /** Resolve (and cache) the issuer's endpoints from its discovery document. */
  discoverEndpoints(): Promise<OidcEndpoints>;
  /** Exchange an authorization code for an access token. */
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  /** Fetch the authenticated user's identity. */
  fetchUser(accessToken: string): Promise<OidcUser>;
}

export function createDefaultOidcDeps(
  issuer: string,
  clientId: string,
  clientSecret: string,
): OidcOAuthDeps {
  let cachedEndpoints: OidcEndpoints | null = null;
  const discoverEndpoints = async (): Promise<OidcEndpoints> => {
    if (cachedEndpoints) return cachedEndpoints;
    const res = await fetch(discoveryDocumentUrl(issuer), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new OidcError(`OIDC discovery document returned ${res.status}`);
    }
    const doc = (await res.json()) as {
      authorization_endpoint?: unknown;
      token_endpoint?: unknown;
      userinfo_endpoint?: unknown;
    };
    const endpoints: OidcEndpoints = {
      authorizationEndpoint: String(doc.authorization_endpoint ?? ''),
      tokenEndpoint: String(doc.token_endpoint ?? ''),
      userinfoEndpoint: String(doc.userinfo_endpoint ?? ''),
    };
    for (const [key, value] of Object.entries(endpoints)) {
      if (!value.startsWith('http')) {
        throw new OidcError(`OIDC discovery document is missing a usable ${key}`);
      }
    }
    cachedEndpoints = endpoints;
    return endpoints;
  };
  return {
    discoverEndpoints,
    async exchangeCode(code, redirectUri) {
      const { tokenEndpoint } = await discoverEndpoints();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      });
      const res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      if (!res.ok) {
        throw new OidcError(`OIDC token endpoint returned ${res.status}`);
      }
      const data = (await res.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!data.access_token) {
        throw new OidcError(
          `OIDC token exchange failed: ${data.error ?? 'unknown'}${
            data.error_description ? ` — ${data.error_description}` : ''
          }`,
        );
      }
      return data.access_token;
    },
    async fetchUser(accessToken) {
      const { userinfoEndpoint } = await discoverEndpoints();
      const res = await fetch(userinfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new OidcError(`OIDC userinfo endpoint returned ${res.status}`);
      }
      const claims = (await res.json()) as {
        sub?: unknown;
        name?: unknown;
        preferred_username?: unknown;
        email?: unknown;
      };
      if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
        throw new OidcError('OIDC userinfo response is missing the `sub` claim');
      }
      return {
        sub: claims.sub,
        name: typeof claims.name === 'string' ? claims.name : null,
        preferred_username:
          typeof claims.preferred_username === 'string' ? claims.preferred_username : null,
        email: typeof claims.email === 'string' ? claims.email : null,
      };
    },
  };
}

/**
 * The provider string stored in `users.provider` for OIDC identities
 * (spec §0 decision 3): the normalized issuer URL. Distinct issuers map to
 * distinct providers, so swapping IdPs provisions fresh users rather than
 * silently rebinding existing ones.
 */
export function oidcProviderId(issuer: string): string {
  return normalizeIssuerUrl(issuer);
}
