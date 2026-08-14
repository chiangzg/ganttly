/**
 * Server configuration (spec §14.2 + §8.2 fail-fast rules).
 *
 * Config is parsed once from the process environment by {@link loadConfig}.
 * Parsing is pure (takes an explicit env record) so it is unit-testable. The
 * server entry point calls {@link getConfig} for a memoised singleton.
 *
 * Fail-fast rules:
 * - `DATABASE_URL`, base URLs and instance identity are required everywhere.
 * - `AUTH_MODE=dev` is rejected when `NODE_ENV=production` (spec §8.2).
 * - In production, the GitHub OAuth secrets, `SESSION_SECRET` and
 *   `TOKEN_PEPPER` are required; dev mode derives non-secret placeholders so a
 *   local server boots with zero extra setup.
 */
import { z } from 'zod';
import { DEFAULT_LIMITS } from '@ganttly/api-contract';

const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
const NodeEnv = z.enum(['development', 'production', 'test']);
const AuthMode = z.enum(['dev', 'github']);

const rawConfigSchema = z.object({
  NODE_ENV: NodeEnv.default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  LOG_LEVEL: LogLevel.default('info'),

  DATABASE_URL: z.string().min(1),

  PUBLIC_BASE_URL: z.string().url(),
  WEB_APP_URL: z.string().url(),
  GANTTLY_INSTANCE_ID: z.string().min(1),
  GANTTLY_INSTANCE_NAME: z.string().min(1),

  AUTH_MODE: AuthMode.default('github'),
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  TOKEN_PEPPER: z.string().optional(),
  ALLOWED_WEB_ORIGINS: z.string().default(''),

  MAX_PROJECT_BYTES: z.coerce.number().int().positive().default(DEFAULT_LIMITS.maxProjectBytes),
  MAX_PROJECT_TASKS: z.coerce.number().int().positive().default(DEFAULT_LIMITS.maxProjectTasks),
  /** Default PAT lifetime in days when the client omits `expiresAt` (spec §8.3). */
  PAT_DEFAULT_TTL_DAYS: z.coerce.number().int().positive().default(90),

  // --- Transactional outbox / SSE (spec §11.2) -------------------------------
  /** How often the publisher polls for unpublished events. */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  /** Max events drained per poll (FOR UPDATE SKIP LOCKED batch). */
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  /** Published rows older than this are pruned (cursor retention window). */
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  /** Warn when the unpublished backlog reaches this many rows. */
  OUTBOX_LAG_ALERT_THRESHOLD: z.coerce.number().int().positive().default(1000),
  /** Prune + sample interval for the maintenance loop. */
  OUTBOX_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
});

export type AuthMode = z.infer<typeof AuthMode>;

export interface AppConfig {
  nodeEnv: z.infer<typeof NodeEnv>;
  port: number;
  logLevel: z.infer<typeof LogLevel>;
  databaseUrl: string;

  publicBaseUrl: string;
  webAppUrl: string;
  instanceId: string;
  instanceName: string;

  authMode: AuthMode;
  githubOAuthClientId?: string;
  githubOAuthClientSecret?: string;
  sessionSecret: string;
  tokenPepper: string;
  /** Parsed, de-duplicated CORS origin list (empty = no origins allowed). */
  allowedWebOrigins: string[];
  /** Hostnames accepted by the /mcp endpoint (DNS-rebinding defence). */
  allowedMcpHosts: ReadonlySet<string>;

  maxProjectBytes: number;
  maxProjectTasks: number;
  /** Default PAT lifetime in days (spec §8.3). */
  patDefaultTtlDays: number;

  /** Transactional outbox / SSE tuning (spec §11.2). */
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  outboxRetentionDays: number;
  outboxLagAlertThreshold: number;
  outboxMaintenanceIntervalMs: number;

  /** True when running outside development/test. */
  isProduction: boolean;
}

/** Thrown when configuration is missing or internally inconsistent. */
export class ConfigError extends Error {
  readonly details: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }
}

const PROD_SECRET_KEYS = [
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'SESSION_SECRET',
  'TOKEN_PEPPER',
] as const;

const DEV_SESSION_SECRET = 'dev-session-secret-not-for-production-use';
/** Dev-only pepper (non-secret); tests use it to verify PAT hashing. */
export const DEV_TOKEN_PEPPER = 'dev-token-pepper-not-for-production-use';

/**
 * Parse and validate configuration. Throws {@link ConfigError} (fail-fast) on
 * any violation — the process should exit without serving traffic.
 *
 * @param env environment source; defaults to `process.env`.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = rawConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError('Invalid configuration', details);
  }
  const r = parsed.data;
  const isProduction = r.NODE_ENV === 'production';

  // §8.2: production must never run dev auth.
  if (isProduction && r.AUTH_MODE === 'dev') {
    throw new ConfigError('AUTH_MODE=dev is not permitted in production (NODE_ENV=production).', [
      'Set AUTH_MODE=github and configure the GitHub OAuth + session/pepper secrets.',
    ]);
  }

  // github auth (or production) requires the real secrets.
  const needSecrets = r.AUTH_MODE === 'github' || isProduction;
  if (needSecrets) {
    const missing = PROD_SECRET_KEYS.filter((k) => !env[k] || env[k]!.trim() === '');
    if (missing.length > 0) {
      throw new ConfigError('Missing required production configuration.', missing);
    }
  }

  const sessionSecret = r.SESSION_SECRET ?? (r.AUTH_MODE === 'dev' ? DEV_SESSION_SECRET : '');
  const tokenPepper = r.TOKEN_PEPPER ?? (r.AUTH_MODE === 'dev' ? DEV_TOKEN_PEPPER : '');
  if (needSecrets && (!sessionSecret || !tokenPepper)) {
    // Defensive: schema guarantees presence when needSecrets, but keep the
    // invariant explicit rather than relying on optional widening.
    throw new ConfigError('SESSION_SECRET and TOKEN_PEPPER are required in production.', [
      'SESSION_SECRET',
      'TOKEN_PEPPER',
    ]);
  }

  const allowedWebOrigins = r.ALLOWED_WEB_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Hostnames the /mcp endpoint will accept (DNS-rebinding defence, spec §13).
  // Derived from PUBLIC_BASE_URL; dev also allows localhost variants.
  const publicHost = hostOf(r.PUBLIC_BASE_URL);
  const allowedMcpHosts = new Set<string>(publicHost ? [publicHost] : []);
  if (!isProduction) {
    allowedMcpHosts.add('localhost');
    allowedMcpHosts.add('127.0.0.1');
  }

  return {
    nodeEnv: r.NODE_ENV,
    port: r.PORT,
    logLevel: r.LOG_LEVEL,
    databaseUrl: r.DATABASE_URL,
    publicBaseUrl: r.PUBLIC_BASE_URL,
    webAppUrl: r.WEB_APP_URL,
    instanceId: r.GANTTLY_INSTANCE_ID,
    instanceName: r.GANTTLY_INSTANCE_NAME,
    authMode: r.AUTH_MODE,
    githubOAuthClientId: r.GITHUB_OAUTH_CLIENT_ID,
    githubOAuthClientSecret: r.GITHUB_OAUTH_CLIENT_SECRET,
    sessionSecret,
    tokenPepper,
    allowedWebOrigins,
    allowedMcpHosts,
    maxProjectBytes: r.MAX_PROJECT_BYTES,
    maxProjectTasks: r.MAX_PROJECT_TASKS,
    patDefaultTtlDays: r.PAT_DEFAULT_TTL_DAYS,
    outboxPollIntervalMs: r.OUTBOX_POLL_INTERVAL_MS,
    outboxBatchSize: r.OUTBOX_BATCH_SIZE,
    outboxRetentionDays: r.OUTBOX_RETENTION_DAYS,
    outboxLagAlertThreshold: r.OUTBOX_LAG_ALERT_THRESHOLD,
    outboxMaintenanceIntervalMs: r.OUTBOX_MAINTENANCE_INTERVAL_MS,
    isProduction,
  };
}

let cached: AppConfig | null = null;

/** Memoised singleton; callers should use this at runtime. */
export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test-only: reset the memoised singleton between cases. */
export function resetConfigCacheForTests(): void {
  cached = null;
}

/** Extract the host (without port) from a URL; undefined for invalid input. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
