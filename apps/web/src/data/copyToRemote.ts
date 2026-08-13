/**
 * Copy a local project to a remote workspace (spec §2.4).
 *
 * This is a one-way upload — the local project is not modified or linked to
 * the remote copy. The server mints a fresh project id and stamps its own
 * `meta.createdAt`/`updatedAt`; the client navigates to the new remote ref
 * after success.
 *
 * The request carries an `Idempotency-Key` so a network retry never creates a
 * duplicate remote project. The key is generated once by the caller and held
 * in dialog state for the duration of the upload attempt.
 */
import type { GanttlyFile } from '@ganttly/schema';
import type { ProjectSnapshotResponse } from '@ganttly/api-contract';
import { normalizeFile, validateGanttlyFile } from '@ganttly/schema';
import type { ProjectRef } from './projectRef';
import type { HttpClient } from './httpClient';

export interface CopyToRemoteParams {
  httpClient: HttpClient;
  instanceId: string;
  workspaceId: string;
  name: string;
  file: GanttlyFile;
  sourceClientId?: string;
  idempotencyKey: string;
}

/**
 * Pre-validate the file client-side before uploading (spec §12.5). The server
 * re-validates, but catching obvious issues here gives faster feedback.
 */
export function prepareRemoteCopy(file: GanttlyFile): GanttlyFile {
  const normalized = normalizeFile(file);
  const result = validateGanttlyFile(normalized);
  if (!result.ok) {
    throw new Error(
      `项目文件校验失败: ${result.errors.map((e) => e.instancePath || e.message).join(', ')}`,
    );
  }
  return normalized;
}

export async function copyProjectToRemote(params: CopyToRemoteParams): Promise<ProjectRef> {
  const { httpClient, instanceId, workspaceId, name, file, sourceClientId, idempotencyKey } =
    params;
  const prepared = prepareRemoteCopy(file);
  const { data } = await httpClient.request<ProjectSnapshotResponse>(
    `/api/v1/workspaces/${workspaceId}/projects/import`,
    {
      method: 'POST',
      body: { name, file: prepared, sourceClientId },
      idempotencyKey,
    },
  );
  return {
    instanceId,
    workspaceId,
    projectId: data.summary.id,
  };
}
