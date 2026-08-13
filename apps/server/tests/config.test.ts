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
