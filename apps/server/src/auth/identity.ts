/**
 * Identity provisioning (spec §8.2 step 4).
 *
 * Upserts a user by `(provider, subject)` and guarantees they own a `personal`
 * workspace — the one operation shared by the GitHub login callback and the
 * dev-session bootstrap. The whole thing runs in one transaction so a partial
 * login (user row without a workspace) can never be observed.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { users, workspaces, workspaceMembers } from '../db/schema';
import { newUserId, newWorkspaceId } from '../id';

export interface ProvisionInput {
  provider: string;
  subject: string;
  email: string | null;
  displayName: string | null;
}

export interface ProvisionResult {
  userId: string;
  workspaceId: string;
  /** True when a personal workspace had to be created (first login). */
  isNewUser: boolean;
}

export async function provisionUser(db: Db, input: ProvisionInput): Promise<ProvisionResult> {
  const now = new Date();
  return db.transaction(async (tx) => {
    // Upsert by (provider, subject). `ON CONFLICT DO UPDATE` refreshes identity
    // fields so a renamed GitHub account stays in sync on each login.
    const upserted = await tx
      .insert(users)
      .values({
        id: newUserId(),
        provider: input.provider,
        subject: input.subject,
        email: input.email,
        displayName: input.displayName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [users.provider, users.subject],
        set: {
          email: input.email,
          displayName: input.displayName,
          updatedAt: now,
        },
      })
      .returning({ id: users.id });
    const user = upserted[0];
    if (!user) throw new Error('user upsert returned no row');
    const userId = user.id;

    const [existing] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.createdBy, userId), eq(workspaces.kind, 'personal')))
      .limit(1);

    if (existing) {
      return { userId, workspaceId: existing.id, isNewUser: false };
    }

    const workspaceId = newWorkspaceId();
    await tx.insert(workspaces).values({
      id: workspaceId,
      name: input.displayName ?? input.subject,
      kind: 'personal',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(workspaceMembers).values({
      workspaceId,
      userId,
      role: 'owner',
      createdAt: now,
    });
    return { userId, workspaceId, isNewUser: true };
  });
}

/** Fixed identity for `AUTH_MODE=dev` (spec §8.2 — dev-only test user). */
export const DEV_PROVIDER = 'dev';
export const DEV_SUBJECT = 'dev-user';
export const DEV_DISPLAY_NAME = 'Dev User';
export const DEV_EMAIL = 'dev@local';
