import { describe, expect, it } from 'vitest';
import {
  LOCAL_INSTANCE,
  LOCAL_WORKSPACE,
  isLocalRef,
  localRef,
  localScope,
  parseRefKey,
  refEqual,
  refKey,
  scopeEqual,
  scopeKey,
} from '@/data/projectRef';

describe('projectRef', () => {
  describe('localRef / localScope', () => {
    it('builds a local ref with the reserved ids', () => {
      expect(localRef('prj_abc')).toEqual({
        instanceId: LOCAL_INSTANCE,
        workspaceId: LOCAL_WORKSPACE,
        projectId: 'prj_abc',
      });
    });

    it('localScope uses the reserved ids', () => {
      expect(localScope()).toEqual({ instanceId: 'local', workspaceId: 'local' });
    });
  });

  describe('isLocalRef', () => {
    it('true for local instance', () => {
      expect(isLocalRef(localRef('x'))).toBe(true);
    });
    it('false for remote instance', () => {
      const remote = { instanceId: 'official', workspaceId: 'ws_1', projectId: 'p1' };
      expect(isLocalRef(remote)).toBe(false);
    });
  });

  describe('refEqual', () => {
    it('true when all three segments match', () => {
      const a = { instanceId: 'i', workspaceId: 'w', projectId: 'p' };
      expect(refEqual(a, { ...a })).toBe(true);
    });
    it('false when any segment differs', () => {
      const a = { instanceId: 'i', workspaceId: 'w', projectId: 'p' };
      expect(refEqual(a, { ...a, projectId: 'q' })).toBe(false);
      expect(refEqual(a, { ...a, workspaceId: 'x' })).toBe(false);
      expect(refEqual(a, { ...a, instanceId: 'y' })).toBe(false);
    });
  });

  describe('scopeEqual', () => {
    it('compares only instance + workspace', () => {
      const s = { instanceId: 'i', workspaceId: 'w' };
      expect(scopeEqual(s, { ...s })).toBe(true);
      expect(scopeEqual(s, { instanceId: 'i', workspaceId: 'other' })).toBe(false);
    });
  });

  describe('refKey / parseRefKey', () => {
    it('produces a stable slash-separated key', () => {
      expect(refKey({ instanceId: 'inst', workspaceId: 'ws', projectId: 'prj' })).toBe(
        'inst/ws/prj',
      );
    });

    it('parseRefKey round-trips', () => {
      const ref = { instanceId: 'official', workspaceId: 'ws_abc', projectId: 'prj_xyz' };
      expect(parseRefKey(refKey(ref))).toEqual(ref);
    });

    it('returns null for malformed keys', () => {
      expect(parseRefKey('a/b')).toBeNull();
      expect(parseRefKey('a/b/c/d')).toBeNull();
      expect(parseRefKey('')).toBeNull();
    });

    it('returns null if any segment is empty', () => {
      expect(parseRefKey('a//c')).toBeNull();
    });
  });

  describe('scopeKey', () => {
    it('produces instance/workspace', () => {
      expect(scopeKey({ instanceId: 'inst', workspaceId: 'ws' })).toBe('inst/ws');
    });
  });
});
