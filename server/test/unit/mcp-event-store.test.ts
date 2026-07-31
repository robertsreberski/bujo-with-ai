import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { BoundedMcpEventStore } from '../../src/mcp/event-store.js';

describe('BoundedMcpEventStore', () => {
  it('evicts the oldest event and replays later events from the same stream once', async () => {
    const store = new BoundedMcpEventStore(2);
    const first = await store.storeEvent('notifications', {
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    });
    const cursor = await store.storeEvent('notifications', {
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    });
    await store.storeEvent('another-stream', {
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    });
    const missed = await store.storeEvent('notifications', {
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    });

    expect(await store.getStreamIdForEventId(first)).toBeUndefined();
    expect(await store.getStreamIdForEventId(cursor)).toBeUndefined();

    const replayed: Array<{ id: string; message: JSONRPCMessage }> = [];
    const latestCursor = await store.storeEvent('notifications', {
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    });
    const streamId = await store.replayEventsAfter(missed, {
      send: async (id, message) => {
        replayed.push({ id, message });
      },
    });

    expect(streamId).toBe('notifications');
    expect(replayed).toEqual([
      {
        id: latestCursor,
        message: {
          jsonrpc: '2.0',
          method: 'notifications/resources/list_changed',
        },
      },
    ]);
  });

  it('delivers stores racing an awaited replay and the SDK stream-registration handoff once', async () => {
    const store = new BoundedMcpEventStore(10);
    const cursor = await store.storeEvent('notifications', {
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    });
    const event2 = await store.storeEvent('notifications', {
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    });
    let releaseEvent2: (() => void) | undefined;
    let event2Started: (() => void) | undefined;
    const event2Gate = new Promise<void>((resolve) => {
      releaseEvent2 = resolve;
    });
    const started = new Promise<void>((resolve) => {
      event2Started = resolve;
    });
    const delivered: string[] = [];
    const replayedEventIds = new Set<string>();
    let event3Store: Promise<string> | undefined;

    const replay = store.replayEventsAfter(cursor, {
      send: async (id) => {
        delivered.push(id);
        replayedEventIds.add(id);
        if (id === event2) {
          event2Started?.();
          event3Store = store.storeEvent('notifications', {
            jsonrpc: '2.0',
            method: 'notifications/resources/list_changed',
          });
          await event2Gate;
        }
      },
    });
    await started;
    releaseEvent2?.();
    expect(await replay).toBe('notifications');
    if (!event3Store) throw new Error('Concurrent event store did not start.');
    const event3 = await event3Store;

    expect(delivered).toEqual([event2, event3]);
    expect(replayedEventIds).toEqual(new Set([event2, event3]));

    // The replay sink remains active through the next macrotask, matching the
    // SDK's window between replay resolution and resumed-stream registration.
    const event4 = await store.storeEvent('notifications', {
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    });
    expect(delivered).toEqual([event2, event3, event4]);
    expect(replayedEventIds.has(event4)).toBe(true);
  });
});
