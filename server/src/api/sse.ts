import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

export type ChangeKind =
  | 'entry.created'
  | 'entry.updated'
  | 'entry.deleted'
  | 'collection.changed'
  | 'activity.appended'
  | 'summary.changed'
  | 'settings.changed'
  | 'token.changed';

export interface Change {
  kind: ChangeKind | (string & {});
  payload: unknown;
}

export interface ChangeOrigin {
  kind: 'app' | 'mcp' | 'system' | (string & {});
  deviceId?: string | undefined;
  tokenId?: string | undefined;
  tokenLabel?: string | undefined;
  tool?: string | undefined;
}

export interface ChangeBatch {
  transactionId: string;
  mutationId: string | null;
  origin: ChangeOrigin;
  changes: readonly Change[];
}

interface JournaledEvent {
  sequence: number;
  cursor: string;
  frame: string;
}

interface Client {
  response: Response;
  heartbeat?: NodeJS.Timeout;
  bufferingLive: boolean;
  pendingFrames: string[];
  pendingBytes: number;
}

export interface SseHubOptions {
  capacity?: number;
  epoch?: string;
  heartbeatMs?: number;
  maxClientBufferBytes?: number;
}

function serializeEvent(event: string, cursor: string, data: unknown): string {
  return `event: ${event}\nid: ${cursor}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseCursor(raw: string): { epoch: string; sequence: number } | null {
  const split = raw.lastIndexOf(':');
  if (split <= 0) return null;
  const epoch = raw.slice(0, split);
  const sequence = Number(raw.slice(split + 1));
  if (!epoch || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  return { epoch, sequence };
}

export class SseHub {
  readonly epoch: string;
  private readonly capacity: number;
  private readonly heartbeatMs: number;
  private readonly maxClientBufferBytes: number;
  private sequence = 0;
  private readonly journal: JournaledEvent[] = [];
  private readonly clients = new Set<Client>();

  constructor(options: SseHubOptions = {}) {
    this.epoch = options.epoch ?? randomUUID();
    this.capacity = options.capacity ?? 1_000;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.maxClientBufferBytes = options.maxClientBufferBytes ?? 4 * 1_024 * 1_024;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new TypeError('SSE journal capacity must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.maxClientBufferBytes) || this.maxClientBufferBytes < 1) {
      throw new TypeError('SSE client buffer limit must be a positive safe integer.');
    }
  }

  get cursor(): string {
    return `${this.epoch}:${this.sequence}`;
  }

  publish(batch: ChangeBatch): string {
    this.sequence += 1;
    const event: JournaledEvent = {
      sequence: this.sequence,
      cursor: this.cursor,
      frame: serializeEvent('change', this.cursor, batch),
    };
    this.journal.push(event);
    if (this.journal.length > this.capacity) this.journal.shift();

    for (const client of this.clients) {
      if (client.bufferingLive) this.bufferLiveFrame(client, event.frame);
      else this.writeClient(client, event.frame);
    }
    return event.cursor;
  }

  handler: RequestHandler = (request, response) => {
    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    // Register before replay so a publish racing the handoff cannot be lost. Live
    // frames remain bounded in-memory until replay-ready has been written.
    const client: Client = {
      response,
      bufferingLive: true,
      pendingFrames: [],
      pendingBytes: 0,
    };
    this.clients.add(client);
    request.on('close', () => this.removeClient(client));
    response.on('close', () => this.removeClient(client));

    const replaySequence = this.sequence;
    const replayCursor = `${this.epoch}:${replaySequence}`;
    const replayJournal = this.journal.filter((event) => event.sequence <= replaySequence);
    const requested = this.requestedCursor(request);
    if (requested !== null) {
      const parsed = parseCursor(requested);
      const oldestSequence = replayJournal[0]?.sequence ?? replaySequence + 1;
      if (
        parsed === null ||
        parsed.epoch !== this.epoch ||
        parsed.sequence > replaySequence ||
        parsed.sequence < oldestSequence - 1
      ) {
        this.writeClient(
          client,
          serializeEvent('reset', replayCursor, {
            reason: parsed?.epoch === this.epoch ? 'cursor_evicted' : 'server_restarted',
            currentCursor: replayCursor,
          }),
        );
      } else {
        for (const event of replayJournal) {
          if (
            event.sequence > parsed.sequence &&
            event.sequence <= replaySequence &&
            !this.writeClient(client, event.frame)
          ) {
            break;
          }
        }
      }
    }

    if (!this.clients.has(client)) return;
    if (
      !this.writeClient(
        client,
        serializeEvent('replay-ready', replayCursor, { cursor: replayCursor }),
      )
    ) {
      return;
    }
    this.flushBufferedLiveFrames(client);
    if (!this.clients.has(client)) return;
    client.heartbeat = setInterval(
      () => this.writeClient(client, ': keep-alive\n\n'),
      this.heartbeatMs,
    );
    client.heartbeat.unref();
  };

  close(): void {
    for (const client of [...this.clients]) {
      this.removeClient(client);
      if (!client.response.writableEnded) client.response.end();
    }
  }

  private requestedCursor(request: Request): string | null {
    const queryCursor = request.query.cursor;
    if (typeof queryCursor === 'string' && queryCursor) return queryCursor;
    const lastEventId = request.get('last-event-id');
    return lastEventId || null;
  }

  private removeClient(client: Client): void {
    if (!this.clients.delete(client)) return;
    if (client.heartbeat) clearInterval(client.heartbeat);
    client.pendingFrames.length = 0;
    client.pendingBytes = 0;
    client.bufferingLive = false;
  }

  private bufferLiveFrame(client: Client, frame: string): void {
    const frameBytes = Buffer.byteLength(frame);
    if (
      client.response.writableLength + client.pendingBytes + frameBytes >
      this.maxClientBufferBytes
    ) {
      this.disconnectSlowClient(client);
      return;
    }
    client.pendingFrames.push(frame);
    client.pendingBytes += frameBytes;
  }

  private flushBufferedLiveFrames(client: Client): void {
    while (this.clients.has(client) && client.pendingFrames.length > 0) {
      const frame = client.pendingFrames.shift();
      if (frame === undefined) break;
      client.pendingBytes -= Buffer.byteLength(frame);
      if (!this.writeClient(client, frame)) return;
    }
    client.bufferingLive = false;
  }

  private writeClient(client: Client, frame: string): boolean {
    const { response } = client;
    if (response.destroyed || response.writableEnded) {
      this.removeClient(client);
      return false;
    }
    if (response.writableLength + Buffer.byteLength(frame) > this.maxClientBufferBytes) {
      this.disconnectSlowClient(client);
      return false;
    }
    if (!response.write(frame)) {
      this.disconnectSlowClient(client);
      return false;
    }
    return true;
  }

  private disconnectSlowClient(client: Client): void {
    this.removeClient(client);
    if (!client.response.writableEnded) client.response.end();
  }
}
