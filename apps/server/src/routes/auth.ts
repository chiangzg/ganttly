/**
 * Auth routes (spec §8.2) — OIDC authorization-code web flow + dev bootstrap.
 *
 * Mounted under `/api/v1` by the bootstrap API plugin:
 *   GET  /auth/oidc              — start: redirect to the issuer's authorize URL
 *   GET  /auth/oidc/callback     — exchange code, provision identity, set session
 *   POST /auth/logout            — clear the session cookie
 *   POST /auth/dev-session       — dev-only: provision fixed test user (AUTH_MODE=dev)
 *
 * The issuer is configured via env (any standards-compliant OIDC IdP, e.g.
 * authentik); who may sign in is governed at the IdP by the application's
 * access policies — the server keeps no login allowlist. The network calls
 * are isolated behind {@link OidcOAuthDeps} (default uses global `fetch`);
 * tests inject fakes to drive the callback without hitting a real issuer.
 */
import { ApiErrorCode, buildApiError } from '@ganttly/api-contract';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import {
  buildAuthorizeUrl,
  createDefaultOidcDeps,
  oidcProviderId,
  type OidcOAuthDeps,
} from '../auth/oidc';
import { clearStateCookie, newState, setStateCookie, verifyStateCookie } from '../auth/oauth-state';
import {
  DEV_DISPLAY_NAME,
  DEV_EMAIL,
  DEV_PROVIDER,
  DEV_SUBJECT,
  provisionUser,
} from '../auth/identity';

export interface AuthRoutesOptions {
  config: AppConfig;
  /** Injectable for tests; defaults to the global-`fetch` implementation. */
  oidcDeps?: OidcOAuthDeps;
}

const CALLBACK_PATH = '/api/v1/auth/oidc/callback';

function callbackUrl(config: AppConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, '')}${CALLBACK_PATH}`;
}

function loginErrorUrl(webAppUrl: string, code: string): string {
  return `${webAppUrl}?login_error=${encodeURIComponent(code)}`;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  app: FastifyInstance,
  options,
) => {
  const { config } = options;
  const oidcDeps =
    options.oidcDeps ??
    (config.oidcIssuerUrl && config.oidcClientId && config.oidcClientSecret
      ? createDefaultOidcDeps(config.oidcIssuerUrl, config.oidcClientId, config.oidcClientSecret)
      : undefined);

  // --- GET /auth/oidc: start the OIDC authorization-code flow ---------------
  app.get('/auth/oidc', async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.authMode === 'dev') {
      // Dev mode has no OIDC credentials; clients use POST /auth/dev-session.
      return reply.redirect(loginErrorUrl(config.webAppUrl, 'dev_mode_no_oidc'));
    }
    if (!oidcDeps || !config.oidcIssuerUrl || !config.oidcClientId) {
      return reply
        .code(503)
        .send(
          buildApiError(
            ApiErrorCode.UNSUPPORTED_CLIENT,
            'OIDC login is not configured on this instance',
            request.id,
          ),
        );
    }
    let authorizationEndpoint: string;
    try {
      const endpoints = await oidcDeps.discoverEndpoints();
      authorizationEndpoint = endpoints.authorizationEndpoint;
    } catch (err) {
      // The browser was already navigated here — bounce back with a reason
      // instead of stranding it on a JSON error page.
      request.log.warn({ err }, 'oidc discovery failed at login start');
      return reply.redirect(loginErrorUrl(config.webAppUrl, 'oidc_login_failed'));
    }
    const state = newState();
    setStateCookie(reply, state, { secure: config.isProduction });
    return reply.redirect(
      buildAuthorizeUrl({
        authorizationEndpoint,
        clientId: config.oidcClientId,
        redirectUri: callbackUrl(config),
        state,
        scopes: config.oidcScopes.split(' '),
      }),
    );
  });

  // --- GET /auth/oidc/callback: exchange, provision, set session ------------
  app.get('/auth/oidc/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query ?? {}) as { code?: string; state?: string; error?: string };
    try {
      if (!app.hasDecorator('db')) {
        throw new Error('database_unavailable');
      }
      if (query.error || !query.code || !query.state) {
        throw new Error(`missing_parameters:${query.error ?? 'none'}`);
      }
      if (!oidcDeps || !config.oidcIssuerUrl) {
        throw new Error('oidc_not_configured');
      }
      if (!verifyStateCookie(request, query.state)) {
        throw new Error('state_mismatch');
      }
      const accessToken = await oidcDeps.exchangeCode(query.code, callbackUrl(config));
      const user = await oidcDeps.fetchUser(accessToken);
      const provider = oidcProviderId(config.oidcIssuerUrl);
      const result = await provisionUser(app.db, {
        provider,
        subject: user.sub,
        email: user.email,
        displayName: user.name ?? user.preferred_username ?? user.sub,
      });
      request.session.set('userId', result.userId);
      request.session.set('provider', provider);
      request.session.set('loginAt', new Date().toISOString());
      return reply.redirect(config.webAppUrl);
    } catch (err) {
      request.log.warn({ err }, 'oidc login callback failed');
      return reply.redirect(loginErrorUrl(config.webAppUrl, 'oidc_login_failed'));
    } finally {
      clearStateCookie(reply);
    }
  });

  // --- POST /auth/logout: invalidate the session cookie ---------------------
  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    request.session.delete();
    return reply.code(204).send();
  });

  // --- POST /auth/dev-session: dev-only fixed test user (spec §8.2) ---------
  app.post('/auth/dev-session', async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.authMode !== 'dev') {
      // Hidden in non-dev builds; a 404 avoids leaking the route's existence.
      return reply.code(404).send(buildApiError(ApiErrorCode.NOT_FOUND, 'Not found', request.id));
    }
    if (!app.hasDecorator('db')) {
      return reply
        .code(503)
        .send(buildApiError(ApiErrorCode.UNSUPPORTED_CLIENT, 'database unavailable', request.id));
    }
    // Dev-only affordance for tests: `{ "subject": "…" }` provisions a distinct
    // user so suites can exercise multi-user scenarios. Never available in
    // production (guarded above).
    const body = (request.body ?? {}) as { subject?: unknown };
    const subject =
      typeof body.subject === 'string' && body.subject.trim() !== ''
        ? body.subject.trim()
        : DEV_SUBJECT;
    const result = await provisionUser(app.db, {
      provider: DEV_PROVIDER,
      subject,
      email: DEV_EMAIL,
      displayName: DEV_DISPLAY_NAME,
    });
    request.session.set('userId', result.userId);
    request.session.set('provider', DEV_PROVIDER);
    request.session.set('loginAt', new Date().toISOString());
    return reply.code(200).send({
      ok: true,
      userId: result.userId,
      workspaceId: result.workspaceId,
      isNewUser: result.isNewUser,
    });
  });
};
