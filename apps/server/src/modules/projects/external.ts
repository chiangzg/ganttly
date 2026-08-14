/**
 * External reference deduplication (spec §6.4 / §10.3 `source`).
 *
 * External Agents can attach a stable `(provider, externalId)` to a created
 * task. On re-submission the server returns the already-linked task with
 * `created=false` instead of creating a duplicate. The server stores only the
 * URL; it never fetches its contents.
 */
import { and, eq } from 'drizzle-orm';
import type { ExternalSource } from '@ganttly/api-contract';
import type { Tx } from '../../db/client';
import { externalReferences } from '../../db/schema';

export type ExternalEntityType = 'project' | 'task';

export interface ExternalRefKey {
  workspaceId: string;
  provider: string;
  externalId: string;
  entityType: ExternalEntityType;
}

/**
 * Look up an existing external reference. Returns the linked entity id, or
 * `undefined` when no prior mapping exists.
 */
export async function findExternalReference(
  tx: Tx,
  key: ExternalRefKey,
): Promise<{ entityId: string; url: string | null } | undefined> {
  const rows = await tx
    .select({ entityId: externalReferences.entityId, url: externalReferences.url })
    .from(externalReferences)
    .where(
      and(
        eq(externalReferences.workspaceId, key.workspaceId),
        eq(externalReferences.provider, key.provider),
        eq(externalReferences.externalId, key.externalId),
        eq(externalReferences.entityType, key.entityType),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { entityId: row.entityId, url: row.url };
}

/**
 * Record an external reference. Idempotent on the natural key (the composite
 * primary key); callers should check {@link findExternalReference} first to
 * decide `created` vs dedup.
 */
export async function recordExternalReference(
  tx: Tx,
  key: ExternalRefKey & { projectId: string; entityId: string; source: ExternalSource },
): Promise<void> {
  await tx
    .insert(externalReferences)
    .values({
      workspaceId: key.workspaceId,
      projectId: key.projectId,
      provider: key.provider,
      externalId: key.externalId,
      entityType: key.entityType,
      entityId: key.entityId,
      url: key.source.url ?? null,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
}
