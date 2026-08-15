/**
 * PAT management client for the official instance (spec §8.3).
 *
 * Talks to `/api/v1/me/tokens` via the same-origin session cookie. The plaintext
 * token returned by {@link createPat} is shown exactly once by the UI and never
 * persisted — callers must hand it straight to a transient display component.
 */
import {
  type CreatePatRequest,
  type CreatePatResponse,
  type PatSummary,
} from '@ganttly/api-contract';
import { createHttpClient, type HttpClient } from './httpClient';
import { officialInstance } from '@/store/useInstanceStore';

let cached: HttpClient | null = null;

function client(): HttpClient {
  if (!cached) cached = createHttpClient(officialInstance().baseUrl);
  return cached;
}

/** Drop the cached client so the next call re-resolves the official instance. */
export function resetPatClient(): void {
  cached = null;
}

export async function createPat(params: CreatePatRequest): Promise<CreatePatResponse> {
  const res = await client().request<CreatePatResponse>('/api/v1/me/tokens', {
    method: 'POST',
    body: params,
  });
  return res.data;
}

export async function listPats(): Promise<PatSummary[]> {
  const res = await client().request<{ tokens: PatSummary[] }>('/api/v1/me/tokens');
  return res.data.tokens;
}

export async function revokePat(patId: string): Promise<void> {
  await client().request<void>(`/api/v1/me/tokens/${patId}`, {
    method: 'DELETE',
  });
}

/** Re-exported for UI consumers. */
export type { CreatePatRequest, CreatePatResponse, PatSummary };
