import { describe, expect, it } from 'vitest';
import {
  PAT_TOKEN_PREFIX,
  extractBearerToken,
  generatePatToken,
  hashToken,
  prefixMatches,
} from '../../src/auth/pat';

describe('generatePatToken', () => {
  it('produces a token with the pat_ prefix', () => {
    const { token } = generatePatToken();
    expect(token.startsWith(PAT_TOKEN_PREFIX)).toBe(true);
  });

  it('uses ≥256 bits of entropy (32 random bytes => 43 base64url chars)', () => {
    const { token } = generatePatToken();
    const secret = token.slice(PAT_TOKEN_PREFIX.length);
    // base64url of 32 bytes is 43 chars (no padding).
    expect(secret.length).toBe(43);
  });

  it('generates unique tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generatePatToken().token);
    expect(seen.size).toBe(1000);
  });

  it('returns a display prefix strictly shorter than the token', () => {
    const { token, prefix } = generatePatToken();
    expect(prefix.length).toBeLessThan(token.length);
    expect(token.startsWith(prefix)).toBe(true);
    // Prefix must not leak the whole secret.
    expect(prefix).not.toBe(token);
  });
});

describe('hashToken', () => {
  it('is deterministic for the same token + pepper', () => {
    expect(hashToken('pat_abc', 'pepper-x')).toBe(hashToken('pat_abc', 'pepper-x'));
  });

  it('changes when the pepper changes', () => {
    expect(hashToken('pat_abc', 'pepper-x')).not.toBe(hashToken('pat_abc', 'pepper-y'));
  });

  it('changes when the token changes', () => {
    expect(hashToken('pat_abc', 'pepper-x')).not.toBe(hashToken('pat_abd', 'pepper-x'));
  });

  it('produces a 64-char lowercase hex SHA-256 digest', () => {
    expect(hashToken('pat_abc', 'pepper-x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extractBearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(extractBearerToken('Bearer pat_abc123')).toBe('pat_abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer pat_abc')).toBe('pat_abc');
  });

  it('returns null for a missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  it('returns null for a non-bearer scheme', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('returns null for an empty bearer', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('prefixMatches', () => {
  it('matches a token to its own prefix', () => {
    const { token, prefix } = generatePatToken();
    expect(prefixMatches(token, prefix)).toBe(true);
  });

  it('rejects a mismatched prefix', () => {
    const { token } = generatePatToken();
    expect(prefixMatches(token, 'pat_NOPE')).toBe(false);
  });

  it('rejects a prefix of a different length', () => {
    const { token } = generatePatToken();
    expect(prefixMatches(token, token.slice(0, 5))).toBe(false);
  });
});
