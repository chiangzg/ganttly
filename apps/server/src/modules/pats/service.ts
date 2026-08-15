/**
 * PAT management service (spec §8.3).
 *
 * The Web settings UI creates, lists and revokes a user's own tokens. Tokens
 * authenticate MCP calls (see `auth/pat.ts`); this service owns the lifecycle.
 * Only the short prefix and hash are ever written to the database — the
 * plaintext is returned exactly once from {@link createPat} and then forgotten.
 */
import { and, desc, eq } from 'drizzle-orm';
import { type CreatePatRequest, type PatSummary } from '@ganttly/api-contract';
import { newPersonalAccessTokenId } from '../../id';
import type { Db } from '../../db/client';
import { personalAccessTokens, projects } from '../../db/schema';
import { generatePatToken, hashToken } from '../../auth/pat';
import { webPrincipal } from '../../auth/principal';
import { ApiErrorCode } from '@ganttly/api-contract';
import { requireMembership } from '../access';
import { HttpError } from '../errors';

/** Row shape read back from the table, projected onto {@link PatSummary}. */
interface PatRow {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: readonly string[];
  workspaceId: string | null;
  projectId: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function toSummary(row: PatRow): PatSummary {
  const summary: PatSummary = {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes as readonly PatSummary['scopes'][number][],
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.workspaceId !== null) summary.workspaceId = row.workspaceId;
  if (row.projectId !== null) summary.projectId = row.projectId;
  return summary;
}

export class PatApplicationService {
  constructor(
    private readonly db: Db,
    private readonly pepper: string,
  ) {}

  /**
   * Mint a new PAT. The plaintext token is returned in the result and is the
   * only time it is available; the stored row carries only its prefix + hash.
   *
   * Narrowing fields are validated against the caller's own memberships (spec
   * §8.3): a token may only be narrowed to a workspace/project the caller can
   * already access. Violations throw NOT_FOUND — same response a non-member
   * gets — so foreign workspaces/projects are not leaked (spec §16.2).
   */
  async createPat(
    userId: string,
    params: CreatePatRequest,
    defaultTtlDays: number,
  ): Promise<{ token: string; pat: PatSummary }> {
    if (params.projectId !== undefined) {
      const rows = await this.db
        .select({ workspaceId: projects.workspaceId, deletedAt: projects.deletedAt })
        .from(projects)
        .where(eq(projects.id, params.projectId))
        .limit(1);
      const project = rows[0];
      if (!project || project.deletedAt !== null) {
        throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
      }
      if (params.workspaceId !== undefined && project.workspaceId !== params.workspaceId) {
        throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
      }
      // Membership against the project's real workspace (covers the
      // projectId-without-workspaceId form too).
      await requireMembership(this.db, webPrincipal(userId), project.workspaceId);
    } else if (params.workspaceId !== undefined) {
      await requireMembership(this.db, webPrincipal(userId), params.workspaceId);
    }

    const { token, prefix } = generatePatToken();
    const tokenHash = hashToken(token, this.pepper);
    const now = new Date();
    const expiresAt =
      params.expiresAt !== undefined
        ? new Date(params.expiresAt)
        : new Date(now.getTime() + defaultTtlDays * 24 * 60 * 60 * 1000);

    const id = newPersonalAccessTokenId();
    await this.db.insert(personalAccessTokens).values({
      id,
      userId,
      name: params.name,
      tokenPrefix: prefix,
      tokenHash,
      scopes: [...params.scopes],
      workspaceId: params.workspaceId ?? null,
      projectId: params.projectId ?? null,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
    });

    return {
      token,
      pat: toSummary({
        id,
        name: params.name,
        tokenPrefix: prefix,
        scopes: params.scopes,
        workspaceId: params.workspaceId ?? null,
        projectId: params.projectId ?? null,
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
      }),
    };
  }

  /** List a user's tokens, newest first (revoked ones retained for audit). */
  async listPats(userId: string): Promise<PatSummary[]> {
    const rows = await this.db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, userId))
      .orderBy(desc(personalAccessTokens.createdAt));
    return rows.map((row) => toSummary(row as PatRow));
  }

  /**
   * Revoke a token. Only the owner may revoke their own token; a non-owner
   * caller receives NOT_FOUND so the existence of another user's token is
   * never leaked (spec §16.2).
   */
  async revokePat(userId: string, patId: string): Promise<void> {
    const now = new Date();
    const updated = await this.db
      .update(personalAccessTokens)
      .set({ revokedAt: now })
      .where(and(eq(personalAccessTokens.id, patId), eq(personalAccessTokens.userId, userId)))
      .returning({ id: personalAccessTokens.id });
    if (updated.length === 0) {
      throw new HttpError(ApiErrorCode.NOT_FOUND, 'Token not found');
    }
  }
}
