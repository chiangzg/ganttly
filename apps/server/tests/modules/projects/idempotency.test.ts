import { describe, expect, it } from 'vitest';
import { canonicalRequestHash } from '../../../src/modules/projects/idempotency';

describe('canonicalRequestHash', () => {
  it('is deterministic for the same input', () => {
    expect(canonicalRequestHash({ a: 1, b: 2 })).toBe(canonicalRequestHash({ a: 1, b: 2 }));
  });

  it('is independent of object key order', () => {
    expect(canonicalRequestHash({ a: 1, b: { x: 1, y: 2 } })).toBe(
      canonicalRequestHash({ b: { y: 2, x: 1 }, a: 1 }),
    );
  });

  it('differs for different content', () => {
    expect(canonicalRequestHash({ a: 1 })).not.toBe(canonicalRequestHash({ a: 2 }));
  });

  it('produces a 64-char hex sha256', () => {
    expect(canonicalRequestHash(null)).toMatch(/^[0-9a-f]{64}$/);
  });
});
