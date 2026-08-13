import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  ROLE_RANK,
  type WorkspaceRole,
  meetsRole,
  requirePrincipal,
} from '../../src/modules/access';
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
