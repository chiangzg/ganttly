import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  ROLE_RANK,
  type WorkspaceRole,
  hasScope,
  meetsRole,
  requirePrincipal,
  requireScope,
} from '../../src/modules/access';
import { webPrincipal } from '../../src/auth/principal';
import { HttpError } from '../../src/modules/errors';

describe('ROLE_RANK', () => {
  it('orders viewer < editor < admin < owner', () => {
    const order: WorkspaceRole[] = ['viewer', 'editor', 'admin', 'owner'];
    for (let i = 1; i < order.length; i++) {
      expect(ROLE_RANK[order[i]!]).toBeGreaterThan(ROLE_RANK[order[i - 1]!]!);
    }
  });
});

describe('meetsRole', () => {
  it('is inclusive of the minimum role', () => {
    expect(meetsRole('editor', 'editor')).toBe(true);
  });

  it('grants higher roles', () => {
    expect(meetsRole('owner', 'viewer')).toBe(true);
    expect(meetsRole('admin', 'editor')).toBe(true);
  });

  it('denies lower roles', () => {
    expect(meetsRole('viewer', 'editor')).toBe(false);
    expect(meetsRole('editor', 'owner')).toBe(false);
  });
});

describe('requirePrincipal', () => {
  it('throws AUTH_REQUIRED (401) when the request has no principal', () => {
    const req = { principal: null } as unknown as FastifyRequest;
    try {
      requirePrincipal(req);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('AUTH_REQUIRED');
    }
  });

  it('returns the principal when authenticated', () => {
    const principal = {
      actorType: 'user',
      actorId: 'usr_1',
      userId: 'usr_1',
      scopes: [],
    };
    const req = { principal } as unknown as FastifyRequest;
    expect(requirePrincipal(req)).toBe(principal);
  });
});

describe('hasScope', () => {
  it('grants a scope the principal holds', () => {
    const principal = {
      actorType: 'pat' as const,
      actorId: 'pat_1',
      userId: 'usr_1',
      scopes: ['task:write', 'project:read'] as const,
    };
    expect(hasScope(principal, 'task:write')).toBe(true);
  });

  it('denies a scope the principal lacks', () => {
    const principal = {
      actorType: 'pat' as const,
      actorId: 'pat_1',
      userId: 'usr_1',
      scopes: ['project:read'] as const,
    };
    expect(hasScope(principal, 'task:write')).toBe(false);
  });
});

describe('requireScope', () => {
  it('throws FORBIDDEN when the scope is missing', () => {
    const principal = {
      actorType: 'pat' as const,
      actorId: 'pat_1',
      userId: 'usr_1',
      scopes: ['project:read'] as const,
    };
    try {
      requireScope(principal, 'task:write');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('FORBIDDEN');
    }
  });

  it('passes silently when the scope is held', () => {
    expect(() => requireScope(webPrincipal('usr_1'), 'task:write')).not.toThrow();
  });
});
