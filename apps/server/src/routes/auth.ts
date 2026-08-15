/**
 * Auth routes (spec §8.2) — GitHub OAuth web flow + dev bootstrap.
 *
 * Mounted under `/api/v1` by the bootstrap API plugin:
 *   GET  /auth/github             — start: redirect to GitHub authorize URL
 *   GET  /auth/github/callback     — exchange code, provision identity, set session
 *   POST /auth/logout              — clear the session cookie
 *   POST /auth/dev-session         — dev-only: provision fixed test user (AUTH_MODE=dev)
 *
 * The network calls to GitHub are isolated behind {@link GitHubOAuthDeps}
 * (default uses global `fetch`); tests inject fakes to drive the callback
 * without hitting GitHub.
 */
import { ApiErrorCode, buildApiError } from '@ganttly/api-contract';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import {
  GITHUB_PROVIDER,
  buildAuthorizeUrl,
  createDefaultGitHubDeps,
  type GitHubOAuthDeps,
} from '../auth/github';
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
  githubDeps?: GitHubOAuthDeps;
}

const CALLBACK_PATH = '/api/v1/auth/github/callback';

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
  const githubDeps =
    options.githubDeps ??
    (config.githubOAuthClientId && config.githubOAuthClientSecret
      ? createDefaultGitHubDeps(config.githubOAuthClientId, config.githubOAuthClientSecret)
      : undefined);

  // --- GET /auth/github: start the OAuth web flow --------------------------
  app.get('/auth/github', async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.authMode === 'dev') {
      // Dev mode has no GitHub credentials; clients use POST /auth/dev-session.
      return reply.redirect(loginErrorUrl(config.webAppUrl, 'dev_mode_no_github'));
    }
    if (!githubDeps || !config.githubOAuthClientId) {
      return reply
        .code(503)
        .send(
          buildApiError(
            ApiErrorCode.UNSUPPORTED_CLIENT,
            'GitHub OAuth is not configured on this instance',
            request.id,
          ),
        );
    }
    const state = newState();
    setStateCookie(reply, state, { secure: config.isProduction });
    return reply.redirect(
      buildAuthorizeUrl({
        clientId: config.githubOAuthClientId,
        redirectUri: callbackUrl(config),
        state,
      }),
    );
  });

  // --- GET /auth/github/callback: exchange, provision, set session ---------
  app.get('/auth/github/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query ?? {}) as { code?: string; state?: string; error?: string };
    try {
      if (!app.hasDecorator('db')) {
        throw new Error('database_unavailable');
      }
      if (query.error || !query.code || !query.state) {
        throw new Error(`missing_parameters:${query.error ?? 'none'}`);
      }
      if (!githubDeps) {
        throw new Error('github_not_configured');
      }
      if (!verifyStateCookie(request, query.state)) {
        throw new Error('state_mismatch');
      }
      const accessToken = await githubDeps.exchangeCode(query.code, callbackUrl(config));
      const ghUser = await githubDeps.fetchUser(accessToken);
      const result = await provisionUser(app.db, {
        provider: GITHUB_PROVIDER,
        subject: String(ghUser.id),
        email: ghUser.email,
        displayName: ghUser.name ?? ghUser.login,
      });
      request.session.set('userId', result.userId);
      request.session.set('provider', GITHUB_PROVIDER);
      request.session.set('loginAt', new Date().toISOString());
      return reply.redirect(config.webAppUrl);
    } catch (err) {
      request.log.warn({ err }, 'github login callback failed');
      return reply.redirect(loginErrorUrl(config.webAppUrl, 'github_login_failed'));
    } finally {
      clearStateCookie(reply);
    }
  });

  // --- POST /auth/logout: invalidate the session ---------------------------
  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    request.session.delete();
    return reply.code(204).send();
  });

  // --- POST /auth/dev-session: dev-only fixed test user (spec §8.2) --------
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
