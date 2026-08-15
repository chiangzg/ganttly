/**
 * Project API contract (spec §9.3).
 *
 * Request/response shapes for the project endpoints. The full `GanttlyFile`
 * document is validated separately by AJV (`validateGanttlyFile` in
 * `@ganttly/schema`); the Zod schemas here validate only the request envelope
 * so the document body stays a single source of truth in `schema.json`.
 *
 * `ProjectSummary` is structurally identical to the web client's
 * `apps/web/src/data/repository.ts` type so the same DTO flows through both
 * sides unchanged (PR4 will switch the client to import it from here).
 */
import { z } from 'zod';
import type { GanttlyFile } from '@ganttly/schema';

// ---------------------------------------------------------------------------
// Response types (server → client)
// ---------------------------------------------------------------------------

/**
 * File-derived statistics persisted in `projects.summary_jsonb` (spec §6.1).
 * The non-stat columns (id/name/timestamps) live on the projects row and are
 * merged in by the service when assembling {@link ProjectSummary}.
 */
export interface ProjectStats {
  taskCount: number;
  completedTaskCount: number;
  progress: number;
  startDate?: string;
  endDate?: string;
}

/**
 * Card/list metadata returned without leaking the full document. Matches the
 * web client's `ProjectSummary` exactly.
 */
export interface ProjectSummary extends ProjectStats {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Envelope returned by GET / create / save (spec §9.3 `ProjectSnapshotResponse`). */
export interface ProjectSnapshotResponse {
  summary: ProjectSummary;
  file: GanttlyFile;
  /** Revision as a string — the client's `ProjectRevision` is string-typed. */
  revision: string;
}

/** Response of `POST .../projects/:id/commands`; carries the structured result. */
export interface ApplyCommandResponse extends ProjectSnapshotResponse {
  affectedTaskIds: string[];
  adjustments: Array<{ field: string; from: unknown; to: unknown; reason: string }>;
}

// ---------------------------------------------------------------------------
// Request envelopes (validated by Zod; `file` validated later by AJV)
// ---------------------------------------------------------------------------

/**
 * Require a key to be present and non-null while leaving its value opaque.
 * `z.unknown()` would make the key optional (Zod treats unknown/any fields as
 * optional by default), so a missing `file` would slip through. The document
 * structure itself is validated downstream by AJV (`validateGanttlyFile`).
 */
const requiredPassthrough = z.custom<unknown>((value) => value !== undefined && value !== null, {
  message: 'required',
});

export const createProjectRequestSchema = z.object({
  file: requiredPassthrough,
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const saveProjectRequestSchema = z.object({
  file: requiredPassthrough,
});
export type SaveProjectRequest = z.infer<typeof saveProjectRequestSchema>;

export const importProjectRequestSchema = z.object({
  name: z.string().min(1),
  file: requiredPassthrough,
  sourceClientId: z.string().optional(),
});
export type ImportProjectRequest = z.infer<typeof importProjectRequestSchema>;

export const applyCommandRequestSchema = z.object({
  command: requiredPassthrough,
});
export type ApplyCommandRequest = z.infer<typeof applyCommandRequestSchema>;

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

/**
 * Parse a `?deleted=` query flag safely. `z.coerce.boolean()` would treat the
 * string `"false"` as truthy, so coerce explicitly: only the literal `"true"`
 * enables trash view; any other value (including absence) is false.
 */
const booleanQuery = z.preprocess(
  (value) => (value === undefined ? undefined : value === 'true'),
  z.boolean().optional(),
);

export const listProjectsQuerySchema = z.object({
  deleted: booleanQuery,
  query: z.string().optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
