/**
 * Instance discovery contract (spec §8.1).
 *
 * Each ganttly server instance publishes a descriptor at
 * `GET /.well-known/ganttly-instance`. Clients (Web workspace switcher, MCP
 * hosts adding a self-hosted instance) read it to confirm the URL speaks the
 * ganttly protocol before entering any auth flow. The descriptor is fully
 * public — it must never contain tokens, user info, or internal addresses.
 *
 * The Zod schema is the single source of truth: the server validates its own
 * descriptor with it before responding, and clients validate it after fetch.
 */
import { z } from 'zod';

export const INSTANCE_PROTOCOL = 'ganttly-instance' as const;
export const INSTANCE_PROTOCOL_VERSION = '1' as const;
export const INSTANCE_WELL_KNOWN_PATH = '/.well-known/ganttly-instance' as const;

export const mcpAuthMethodSchema = z.enum(['pat', 'oauth']);
export type McpAuthMethod = z.infer<typeof mcpAuthMethodSchema>;

export const browserModeSchema = z.enum(['session']);
export type BrowserMode = z.infer<typeof browserModeSchema>;

export const authProviderSchema = z.enum(['github']);
export type AuthProvider = z.infer<typeof authProviderSchema>;

export const instanceDiscoverySchema = z.object({
  protocol: z.literal(INSTANCE_PROTOCOL),
  protocolVersion: z.literal(INSTANCE_PROTOCOL_VERSION),
  /** Stable per-installation id; does not change with domain or display name. */
  instanceId: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  apiBaseUrl: z.string().url(),
  webAppUrl: z.string().url(),
  mcp: z.object({
    url: z.string().url(),
    transport: z.literal('streamable-http'),
    authMethods: z.array(mcpAuthMethodSchema).min(1),
  }),
  auth: z.object({
    browserModes: z.array(browserModeSchema).min(1),
    providers: z.array(authProviderSchema),
    /**
     * True when the instance offers `POST /auth/dev-session` (AUTH_MODE=dev).
     * Lets local-development clients show a dev login affordance instead of
     * the GitHub flow, which dev instances always reject. Defaults to false
     * so descriptors from older servers keep parsing.
     */
    devLogin: z.boolean().default(false),
  }),
  events: z.object({
    transport: z.literal('sse'),
    url: z.string().url(),
  }),
  apiVersions: z.array(z.string()).min(1),
  /** Semver; clients compare against their own version. */
  minClientVersion: z.string().min(1),
  features: z.object({
    projectImport: z.boolean(),
    mcp: z.boolean(),
    sse: z.boolean(),
    teamWorkspaces: z.boolean(),
  }),
});

export type InstanceDiscovery = z.infer<typeof instanceDiscoverySchema>;
