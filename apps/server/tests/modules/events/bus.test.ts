import { describe, expect, it } from 'vitest';
import type { ProjectEvent } from '@ganttly/api-contract';
import { createWorkspaceEventBus } from '../../../src/modules/events/bus';

function event(seq: number, workspaceId = 'ws_1'): ProjectEvent {
  return {
    id: seq,
    type: 'project.updated',
    workspaceId,
    actor: { type: 'web', id: 'usr_1' },
    createdAt: '2026-08-12T10:00:00.000Z',
  };
}

describe('WorkspaceEventBus', () => {
  it('delivers events to subscribers of the workspace', () => {
    const bus = createWorkspaceEventBus();
    const received: ProjectEvent[] = [];
    bus.subscribe('ws_1', (e) => received.push(e));

    bus.publish(event(1));
    bus.publish(event(2, 'ws_2')); // different workspace

    expect(received).toHaveLength(1);
    expect(received[0]!.id).toBe(1);
    bus.close();
  });

  it('supports multiple subscribers and reports listener count', () => {
    const bus = createWorkspaceEventBus();
    const a: ProjectEvent[] = [];
    const b: ProjectEvent[] = [];
    bus.subscribe('ws_1', (e) => a.push(e));
    bus.subscribe('ws_1', (e) => b.push(e));

    expect(bus.listenerCount).toBe(2);
    bus.publish(event(7));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    bus.close();
  });

  it('unsubscribe stops delivery and decrements the count', () => {
    const bus = createWorkspaceEventBus();
    const received: ProjectEvent[] = [];
    const unsubscribe = bus.subscribe('ws_1', (e) => received.push(e));

    bus.publish(event(1));
    unsubscribe();
    bus.publish(event(2));

    expect(received).toHaveLength(1);
    expect(bus.listenerCount).toBe(0);
    bus.close();
  });

  it('unsubscribe is idempotent', () => {
    const bus = createWorkspaceEventBus();
    const unsubscribe = bus.subscribe('ws_1', () => undefined);
    unsubscribe();
    unsubscribe(); // second call must not underflow
    expect(bus.listenerCount).toBe(0);
    bus.close();
  });

  it('close removes all listeners', () => {
    const bus = createWorkspaceEventBus();
    bus.subscribe('ws_1', () => undefined);
    bus.subscribe('ws_2', () => undefined);
    expect(bus.listenerCount).toBe(2);
    bus.close();
    expect(bus.listenerCount).toBe(0);
  });

  it('a throwing listener does not prevent delivery to others', () => {
    const bus = createWorkspaceEventBus();
    const ok: ProjectEvent[] = [];
    bus.subscribe('ws_1', () => {
      throw new Error('boom');
    });
    bus.subscribe('ws_1', (e) => ok.push(e));

    bus.publish(event(5));

    expect(ok).toHaveLength(1);
    expect(ok[0]!.id).toBe(5);
    bus.close();
  });
});
