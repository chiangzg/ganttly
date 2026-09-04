import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { validDevEnv } from './helpers';

describe('loadConfig — happy path', () => {
  it('parses a complete dev environment', () => {
    const cfg = loadConfig(validDevEnv());
    expect(cfg.isProduction).toBe(false);
    expect(cfg.authMode).toBe('dev');
    expect(cfg.port).toBe(3001);
    expect(cfg.instanceId).toBe('inst_test');
    // dev mode supplies non-secret placeholders so a local server boots.
    expect(cfg.sessionSecret).toMatch(/dev-session-secret/);
    expect(cfg.tokenPepper).toMatch(/dev-token-pepper/);
    expect(cfg.allowedWebOrigins).toEqual(['http://localhost:5173']);
  });

  it('applies documented defaults', () => {
    const cfg = loadConfig({ ...validDevEnv(), PORT: '4040', LOG_LEVEL: undefined });
    expect(cfg.port).toBe(4040);
    expect(cfg.logLevel).toBe('info');
  });

  it('defaults the PAT TTL to 90 days', () => {
    const cfg = loadConfig(validDevEnv());
    expect(cfg.patDefaultTtlDays).toBe(90);
  });

  it('honours an explicit PAT_DEFAULT_TTL_DAYS override', () => {
    const cfg = loadConfig({ ...validDevEnv(), PAT_DEFAULT_TTL_DAYS: '30' });
    expect(cfg.patDefaultTtlDays).toBe(30);
  });

  it('defaults the outbox/SSE tuning knobs', () => {
    const cfg = loadConfig(validDevEnv());
    expect(cfg.outboxPollIntervalMs).toBe(250);
    expect(cfg.outboxBatchSize).toBe(100);
    expect(cfg.outboxRetentionDays).toBe(7);
    expect(cfg.outboxLagAlertThreshold).toBe(1000);
    expect(cfg.outboxMaintenanceIntervalMs).toBe(30_000);
  });

  it('honours explicit outbox overrides (coerced from strings)', () => {
    const cfg = loadConfig({
      ...validDevEnv(),
      OUTBOX_POLL_INTERVAL_MS: '500',
      OUTBOX_BATCH_SIZE: '50',
      OUTBOX_RETENTION_DAYS: '14',
    });
    expect(cfg.outboxPollIntervalMs).toBe(500);
    expect(cfg.outboxBatchSize).toBe(50);
    expect(cfg.outboxRetentionDays).toBe(14);
  });

  it('derives allowedMcpHosts from PUBLIC_BASE_URL and allows localhost in dev', () => {
    const cfg = loadConfig(validDevEnv());
    expect(cfg.allowedMcpHosts.has('localhost')).toBe(true);
    expect(cfg.allowedMcpHosts.has('127.0.0.1')).toBe(true);
    // A non-localhost PUBLIC_BASE_URL adds its host too.
    const prodish = loadConfig({ ...validDevEnv(), PUBLIC_BASE_URL: 'https://api.ganttly.com' });
    expect(prodish.allowedMcpHosts.has('api.ganttly.com')).toBe(true);
    expect(prodish.allowedMcpHosts.has('localhost')).toBe(true);
  });

  it('parses a comma-separated CORS list, trimming blanks', () => {
    const cfg = loadConfig({
      ...validDevEnv(),
      ALLOWED_WEB_ORIGINS: ' http://a.com , ,http://b.com ',
    });
    expect(cfg.allowedWebOrigins).toEqual(['http://a.com', 'http://b.com']);
  });

  it('accepts a fully-configured production (github) environment', () => {
    const cfg = loadConfig({
      ...validDevEnv(),
      NODE_ENV: 'production',
      AUTH_MODE: 'github',
      GITHUB_OAUTH_CLIENT_ID: 'id',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
      SESSION_SECRET: 'a'.repeat(48),
      TOKEN_PEPPER: 'b'.repeat(48),
    });
    expect(cfg.isProduction).toBe(true);
    expect(cfg.githubOAuthClientId).toBe('id');
    expect(cfg.sessionSecret).toBe('a'.repeat(48));
  });
});

describe('loadConfig — fail-fast', () => {
  it('rejects a missing DATABASE_URL', () => {
    const env = validDevEnv();
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('rejects an invalid PUBLIC_BASE_URL', () => {
    expect(() => loadConfig({ ...validDevEnv(), PUBLIC_BASE_URL: 'not-a-url' })).toThrow(
      ConfigError,
    );
  });

  it('reports multiple problems at once', () => {
    const err = (() => {
      try {
        loadConfig({ ...validDevEnv(), DATABASE_URL: '', PUBLIC_BASE_URL: 'bad' });
        return null;
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.details.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects AUTH_MODE=dev in production (spec §8.2)', () => {
    expect(() =>
      loadConfig({ ...validDevEnv(), NODE_ENV: 'production', AUTH_MODE: 'dev' }),
    ).toThrow(/AUTH_MODE=dev is not permitted in production/);
  });

  it('requires all production secrets when NODE_ENV=production', () => {
    const env = {
      ...validDevEnv(),
      NODE_ENV: 'production',
      AUTH_MODE: 'github',
      // no secrets provided.
    };
    let err: ConfigError | null = null;
    try {
      loadConfig(env);
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/Missing required production configuration/);
    for (const key of [
      'GITHUB_OAUTH_CLIENT_ID',
      'GITHUB_OAUTH_CLIENT_SECRET',
      'SESSION_SECRET',
      'TOKEN_PEPPER',
    ]) {
      expect(err!.details).toContain(key);
    }
  });

  it('requires secrets when AUTH_MODE=github even in development', () => {
    expect(() => loadConfig({ ...validDevEnv(), AUTH_MODE: 'github' })).toThrow(ConfigError);
  });
});

describe('loadConfig — GitHub login allowlist', () => {
  it('defaults to open login (null) when unset', () => {
    expect(loadConfig(validDevEnv()).allowedGitHubUserIds).toBeNull();
  });

  it('parses a comma-separated numeric id list, trimming blanks and de-duplicating', () => {
    const cfg = loadConfig({ ...validDevEnv(), ALLOWED_GITHUB_USER_IDS: ' 123 , ,456,123 ' });
    expect(cfg.allowedGitHubUserIds).toEqual(new Set(['123', '456']));
  });

  it('treats a whitespace-only value as open login', () => {
    expect(
      loadConfig({ ...validDevEnv(), ALLOWED_GITHUB_USER_IDS: '  ' }).allowedGitHubUserIds,
    ).toBeNull();
  });

  it('rejects non-numeric entries at boot', () => {
    let err: ConfigError | null = null;
    try {
      loadConfig({ ...validDevEnv(), ALLOWED_GITHUB_USER_IDS: 'octocat,123' });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/ALLOWED_GITHUB_USER_IDS/);
    expect(err!.details).toContain('octocat');
  });
});

describe('loadConfig — self-hosted deployment knobs', () => {
  it('defaults WEB_DIST_DIR to empty (API-only mode)', () => {
    const cfg = loadConfig(validDevEnv());
    expect(cfg.webDistDir).toBe('');
  });

  it('honours an explicit WEB_DIST_DIR', () => {
    const cfg = loadConfig({ ...validDevEnv(), WEB_DIST_DIR: '/app/apps/web/dist' });
    expect(cfg.webDistDir).toBe('/app/apps/web/dist');
  });

  it('derives sessionCookieSecure from isProduction when unset', () => {
    expect(loadConfig(validDevEnv()).sessionCookieSecure).toBe(false); // dev
    const prod = loadConfig({
      ...validDevEnv(),
      NODE_ENV: 'production',
      AUTH_MODE: 'github',
      GITHUB_OAUTH_CLIENT_ID: 'id',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
      SESSION_SECRET: 'x'.repeat(32),
      TOKEN_PEPPER: 'p'.repeat(32),
    });
    expect(prod.sessionCookieSecure).toBe(true);
  });

  it('parses SESSION_COOKIE_SECURE="false" as false even in production', () => {
    // z.coerce.boolean() would wrongly coerce "false" to true; manual parse fixes it.
    const cfg = loadConfig({
      ...validDevEnv(),
      NODE_ENV: 'production',
      AUTH_MODE: 'github',
      GITHUB_OAUTH_CLIENT_ID: 'id',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
      SESSION_SECRET: 'x'.repeat(32),
      TOKEN_PEPPER: 'p'.repeat(32),
      SESSION_COOKIE_SECURE: 'false',
    });
    expect(cfg.sessionCookieSecure).toBe(false);
  });

  it('parses SESSION_COOKIE_SECURE="1"/"true" as true in dev', () => {
    expect(loadConfig({ ...validDevEnv(), SESSION_COOKIE_SECURE: '1' }).sessionCookieSecure).toBe(
      true,
    );
    expect(
      loadConfig({ ...validDevEnv(), SESSION_COOKIE_SECURE: 'true' }).sessionCookieSecure,
    ).toBe(true);
    expect(loadConfig({ ...validDevEnv(), SESSION_COOKIE_SECURE: '0' }).sessionCookieSecure).toBe(
      false,
    );
  });

  it('defaults metricsEnabled to true', () => {
    expect(loadConfig(validDevEnv()).metricsEnabled).toBe(true);
  });

  it('parses METRICS_ENABLED="false"/"0" as disabled', () => {
    // z.coerce.boolean() would wrongly coerce the string "false" to true.
    expect(loadConfig({ ...validDevEnv(), METRICS_ENABLED: 'false' }).metricsEnabled).toBe(false);
    expect(loadConfig({ ...validDevEnv(), METRICS_ENABLED: '0' }).metricsEnabled).toBe(false);
    expect(loadConfig({ ...validDevEnv(), METRICS_ENABLED: 'true' }).metricsEnabled).toBe(true);
    expect(loadConfig({ ...validDevEnv(), METRICS_ENABLED: '1' }).metricsEnabled).toBe(true);
  });
});
