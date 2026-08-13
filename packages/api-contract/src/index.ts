/**
 * @ganttly/api-contract — shared API/MCP contract.
 *
 * Contains only DTOs, error codes, instance-discovery schema and document
 * limits. Has no server or web implementation dependency (spec §3.3), so both
 * `apps/web` and `apps/server` can import it.
 */
export * from './errors';
export * from './instance';
export * from './limits';
export * from './project';
