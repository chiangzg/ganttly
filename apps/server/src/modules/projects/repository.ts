/**
 * Project read queries (spec §9.3 GET endpoints).
 *
 * Read helpers run against the connection pool (`app.db`); write paths live in
 * the application service and run inside their own transaction with
 * `SELECT ... FOR UPDATE`. {@link buildSnapshot} assembles the response envelope
 * shared by every endpoint that returns a project.
 */
import { type InferSelectModel, and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { ListProjectsQuery, ProjectSnapshotResponse } from '@ganttly/api-contract';
import type { GanttlyFile } from '@ganttly/schema';
import type { Db } from '../../db/client';
import { projects } from '../../db/schema';
import { buildSummary } from './summary';

export type ProjectRow = InferSelectModel<typeof projects>;

/** Assemble the {@link ProjectSnapshotResponse} envelope from a projects row. */
export function buildSnapshot(row: ProjectRow): ProjectSnapshotResponse {
  return {
    summary: buildSummary(row),
    file: row.fileJsonb as GanttlyFile,
    revision: String(row.revision),
  };
}

/** Fetch a single project, scoped to `workspaceId` (membership checked by caller). */
export async function getProjectRow(
  db: Db,
  workspaceId: string,
  projectId: string,
): Promise<ProjectRow | undefined> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1);
  return rows[0];
}

/**
 * List projects in a workspace. Defaults to active only; `?deleted=true`
 * includes the recycle bin; `?query=` filters case-insensitively on name
 * (using the `lower(name)` index). Ordered by most-recently-updated.
 */
export async function listProjectRows(
  db: Db,
  workspaceId: string,
  query: ListProjectsQuery,
): Promise<ProjectRow[]> {
  const conditions: SQL[] = [eq(projects.workspaceId, workspaceId)];
  if (!query.deleted) {
    conditions.push(isNull(projects.deletedAt));
  }
  if (query.query) {
    conditions.push(sql`lower(${projects.name}) like lower(${'%' + query.query + '%'})`);
  }
  return db
    .select()
    .from(projects)
    .where(and(...conditions))
    .orderBy(desc(projects.updatedAt));
}
