import type {
  EventId,
  EventStore,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface StoredEvent {
  id: EventId;
  streamId: StreamId;
  message: JSONRPCMessage;
}

interface ActiveReplay {
  streamId: StreamId;
  send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
  tail: Promise<void>;
  deliveries: Map<EventId, Promise<void>>;
}

/**
 * Session-local replay storage for Streamable HTTP notifications.
 *
 * Sessions already have a bounded lifetime. This additional event cap prevents
 * a noisy session from retaining an unbounded notification history while still
 * preserving the SDK's Last-Event-ID replay semantics.
 */
export class BoundedMcpEventStore implements EventStore {
  private readonly events: StoredEvent[] = [];
  private readonly eventsById = new Map<EventId, StoredEvent>();
  private readonly activeReplays = new Map<StreamId, ActiveReplay>();
  private nextId = 1;

  constructor(private readonly capacity = 512) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('MCP event-store capacity must be a positive safe integer.');
    }
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const event: StoredEvent = {
      id: `event-${this.nextId}`,
      streamId,
      message,
    };
    this.nextId += 1;
    this.events.push(event);
    this.eventsById.set(event.id, event);

    while (this.events.length > this.capacity) {
      const evicted = this.events.shift();
      if (evicted) this.eventsById.delete(evicted.id);
    }
    const replay = this.activeReplays.get(streamId);
    if (replay) await this.enqueueReplay(replay, event);
    return event.id;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.eventsById.get(eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    options: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const cursor = this.eventsById.get(lastEventId);
    if (!cursor) return '';

    const cursorIndex = this.events.findIndex((event) => event.id === lastEventId);
    if (this.activeReplays.has(cursor.streamId)) {
      throw new Error('An MCP event replay is already active for this stream.');
    }
    const replay: ActiveReplay = {
      streamId: cursor.streamId,
      send: options.send,
      tail: Promise.resolve(),
      deliveries: new Map(),
    };
    this.activeReplays.set(cursor.streamId, replay);

    try {
      for (const event of this.events.slice(cursorIndex + 1)) {
        if (event.streamId === cursor.streamId) await this.enqueueReplay(replay, event);
      }
      await replay.tail;
    } catch (error) {
      this.activeReplays.delete(cursor.streamId);
      throw error;
    }

    // The SDK registers the resumed stream immediately after this promise
    // resolves. Keep routing stores through the replay sink until the next
    // macrotask so no notification can resolve into that handoff gap. Its
    // replayedEventIds set then suppresses the transport's duplicate write.
    setImmediate(() => {
      if (this.activeReplays.get(cursor.streamId) === replay) {
        this.activeReplays.delete(cursor.streamId);
      }
    });
    return cursor.streamId;
  }

  private enqueueReplay(replay: ActiveReplay, event: StoredEvent): Promise<void> {
    const existing = replay.deliveries.get(event.id);
    if (existing) return existing;

    const delivery = replay.tail.then(async () => {
      await replay.send(event.id, event.message);
    });
    replay.deliveries.set(event.id, delivery);
    replay.tail = delivery.catch(() => undefined);
    return delivery;
  }
}
