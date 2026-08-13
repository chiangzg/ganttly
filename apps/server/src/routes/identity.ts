/**
 * Identity & workspace routes (spec §9.2), mounted under `/api/v1`:
 *   GET /me                       — current user profile
 *   GET /workspaces               — workspaces the user belongs to (with role)
 *   GET /workspaces/:workspaceId  — one workspace (membership-gated)
 *
 * Team-workspace creation/invite/member-management is intentionally out of
 * scope for v1 (spec §9.2).
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { users, workspaces, workspaceMembers } from '../db/schema';
import { requireMembership, requirePrincipal } from '../modules/access';
import { HttpError } from '../modules/errors';
import { ApiErrorCode } from '@ganttly/api-contract';

export const identityRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // --- GET /me ---------------------------------------------------------------
  app.get('/me', async (request, reply) => {
    const principal = requirePrincipal(request);
    const rows = await app.db
      .select({
        id: users.id,
        provider: users.provider,
        displayName: users.displayName,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, principal.userId))
      .limit(1);
    const user = rows[0];
    if (!user) {
      throw new HttpError(ApiErrorCode.NOT_FOUND, 'User not found');
    }
    return reply.send(user);
  });

  // --- GET /workspaces -------------------------------------------------------
  app.get('/workspaces', async (request, reply) => {
    const principal = requirePrincipal(request);
    const rows = await app.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        kind: workspaces.kind,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, principal.userId));
    return reply.send({ workspaces: rows });
  });

  // --- GET /workspaces/:workspaceId -----------------------------------------
  app.get('/workspaces/:workspaceId', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId } = request.params as { workspaceId: string };
    const role = await requireMembership(app.db, principal, workspaceId);
    const rows = await app.db
      .select({ id: workspaces.id, name: workspaces.name, kind: workspaces.kind })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const ws = rows[0];
    if (!ws) {
      // Membership existed but the row vanished — treat as not found.
      throw new HttpError(ApiErrorCode.NOT_FOUND, 'Workspace not found');
    }
    return reply.send({ ...ws, role });
  });
};
