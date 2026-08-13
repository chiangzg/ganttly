/**
 * Document & payload limits (spec §9.4).
 *
 * Centralised here so limits are not scattered as hard-coded numbers across
 * routes. The server reads these as the defaults for its config (where they
 * remain overridable via env), and MCP/HTTP layers import the same constants
 * for client-facing validation messages.
 */

export const DEFAULT_LIMITS = {
  /** Max HTTP JSON body size for a whole project document upload. */
  maxProjectBytes: 10 * 1024 * 1024, // 10 MiB
  /** Max tasks within a single project document. */
  maxProjectTasks: 10_000,
  /** Max resources within a single project document. */
  maxProjectResources: 2_000,
  /** Max baselines within a single project document. */
  maxProjectBaselines: 100,
  /** Max items in one batch `create_tasks` request. */
  maxBatchCreateTasks: 100,
  /** Max single MCP response body size; larger content returns a summary. */
  maxMcpResponseBytes: 1024 * 1024, // 1 MiB
} as const;

export type DocumentLimits = typeof DEFAULT_LIMITS;
