import { describe, expect, it } from 'vitest';
import { WEB_SESSION_SCOPES, operationActorType, webPrincipal } from '../../src/auth/principal';

describe('webPrincipal', () => {
  it('builds a user principal with the web-session scopes', () => {
    const p = webPrincipal('usr_abc');
    expect(p).toEqual({
      actorType: 'user',
      actorId: 'usr_abc',
      userId: 'usr_abc',
      scopes: WEB_SESSION_SCOPES,
    });
  });

  it('includes the four role-gated scopes', () => {
    expect(WEB_SESSION_SCOPES).toEqual([
      'workspace:read',
      'project:read',
      'task:write',
      'project:archive',
    ]);
  });
});

describe('operationActorType', () => {
  it('maps a web user to "web"', () => {
    expect(operationActorType(webPrincipal('usr_1'))).toBe('web');
  });

  it('maps a PAT principal to "mcp"', () => {
    expect(
      operationActorType({
        actorType: 'pat',
        actorId: 'pat_1',
        userId: 'usr_1',
        scopes: ['task:write'],
      }),
    ).toBe('mcp');
  });
});
