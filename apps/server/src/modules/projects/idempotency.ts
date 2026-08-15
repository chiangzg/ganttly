/**
 * Idempotency key handling (spec §6.4).
 *
 * A non-idempotent POST carries an `Idempotency-Key` header; the server stores
 * the SHA-256 of the canonicalized request body alongside it. A replay with the
 * same key and the same hash returns the original response; a replay with the
 * same key but a different body is a `409 IDEMPOTENCY_CONFLICT`.
 *
 * Hashing is deterministic regardless of object key order or whitespace, so two
 * semantically-identical bodies hash identically.
 */
import { createHash } from 'node:crypto';

/** Deterministic JSON serialization (object keys sorted recursively). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        sorted[key] = (current as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return current;
  });
}

/** SHA-256 hex of the canonicalized body. Pure. */
export function canonicalRequestHash(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}
