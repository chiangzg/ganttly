import { describe, expect, it } from 'vitest';
import { createPatRequestSchema, MCP_SCOPES, patScopeSchema } from '../src';

describe('MCP_SCOPES', () => {
  it('exposes the fixed four scope values', () => {
    expect(MCP_SCOPES).toEqual(['workspace:read', 'project:read', 'task:write', 'project:archive']);
  });
});

describe('patScopeSchema', () => {
  it('accepts each defined scope', () => {
    for (const scope of MCP_SCOPES) {
      expect(patScopeSchema.parse(scope)).toBe(scope);
    }
  });

  it('rejects an unknown scope', () => {
    expect(() => patScopeSchema.parse('workspace:admin')).toThrow();
  });
});

describe('createPatRequestSchema', () => {
  it('accepts a minimal request with one scope', () => {
    const parsed = createPatRequestSchema.parse({
      name: 'CI bot',
      scopes: ['task:write'],
    });
    expect(parsed.name).toBe('CI bot');
    expect(parsed.scopes).toEqual(['task:write']);
    expect(parsed.workspaceId).toBeUndefined();
    expect(parsed.expiresAt).toBeUndefined();
  });

  it('accepts a fully-scoped token narrowed to a workspace with an expiry', () => {
    const parsed = createPatRequestSchema.parse({
      name: 'Project automation',
      workspaceId: 'ws_abc',
      projectId: 'prj_xyz',
      scopes: ['project:read', 'task:write'],
      expiresAt: '2026-12-31T00:00:00Z',
    });
    expect(parsed.workspaceId).toBe('ws_abc');
    expect(parsed.projectId).toBe('prj_xyz');
    expect(parsed.expiresAt).toBe('2026-12-31T00:00:00Z');
  });

  it('rejects an empty name', () => {
    expect(() => createPatRequestSchema.parse({ name: '', scopes: ['task:write'] })).toThrow();
  });

  it('rejects an empty scopes array', () => {
    expect(() => createPatRequestSchema.parse({ name: 'x', scopes: [] })).toThrow();
  });

  it('rejects an invalid scope value', () => {
    expect(() => createPatRequestSchema.parse({ name: 'x', scopes: ['bogus:scope'] })).toThrow();
  });

  it('rejects a non-ISO datetime for expiresAt', () => {
    expect(() =>
      createPatRequestSchema.parse({
        name: 'x',
        scopes: ['task:write'],
        expiresAt: '2026-12-31',
      }),
    ).toThrow();
  });
});
