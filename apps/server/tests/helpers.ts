import type { AppConfig } from '../src/config';
import { loadConfig } from '../src/config';

/** A complete, valid development environment for config/route tests. */
export function validDevEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'development',
    LOG_LEVEL: 'fatal', // keep test output quiet
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/ganttly_test',
    PUBLIC_BASE_URL: 'http://localhost:3001',
    WEB_APP_URL: 'http://localhost:5173',
    GANTTLY_INSTANCE_ID: 'inst_test',
    GANTTLY_INSTANCE_NAME: 'ganttly Test',
    AUTH_MODE: 'dev',
    ALLOWED_WEB_ORIGINS: 'http://localhost:5173',
    ...overrides,
  };
}

export function buildTestConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig(validDevEnv(overrides));
}
