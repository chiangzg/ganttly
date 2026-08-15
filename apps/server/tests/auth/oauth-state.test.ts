import { describe, expect, it } from 'vitest';
import { newState } from '../../src/auth/oauth-state';

describe('newState', () => {
  it('produces a 32-char hex string (128 bits)', () => {
    const s = newState();
    expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is unique across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(newState());
    expect(seen.size).toBe(5000);
  });
});
