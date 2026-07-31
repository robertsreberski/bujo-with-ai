import {
  ChangeBatchSchema,
  ResetEventSchema,
  SseReplayReadySchema,
  type ChangeBatch,
  type ResetEvent,
} from '../api/types';
import type { z } from 'zod';

export type SseConnectionStatus = 'connecting' | 'connected' | 'error' | 'offline';

type ReplayResult =
  | { status: 'ready' }
  | { status: 'reset' }
  | { status: 'superseded' }
  | { status: 'error'; error: Error };

interface ReplayBarrier {
  generation: number;
  promise: Promise<ReplayResult>;
  resolve: (result: ReplayResult) => void;
  settled: boolean;
  result: ReplayResult | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

export class SseReplayResetError extends Error {
  constructor() {
    super('SSE replay was replaced by a canonical reset.');
    this.name = 'SseReplayResetError';
  }
}

const REPLAY_READY_TIMEOUT_MS = 10_000;

export interface JournalSseClientOptions {
  getCursor: () => string | null;
  onChange: (batch: ChangeBatch, cursor: string) => void | Promise<void>;
  onReset: (event: ResetEvent, cursor: string) => void | Promise<void>;
  onStatus: (status: SseConnectionStatus) => void;
  eventSourceFactory?: (url: string) => EventSource;
}

function parseEvent<T>(event: MessageEvent<string>, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(event.data) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class JournalSseClient {
  private readonly options: JournalSseClientOptions;
  private source: EventSource | null = null;
  private generation = 0;
  private openPromise: Promise<void> | null = null;
  private deliveryTail: Promise<void> = Promise.resolve();
  private replayBarrier: ReplayBarrier | null = null;

  constructor(options: JournalSseClientOptions) {
    this.options = options;
  }

  start(): Promise<void> {
    return this.connect();
  }

  reconnect(): Promise<void> {
    this.closeSource('superseded');
    return this.connect();
  }

  async finishReplay(): Promise<number> {
    const barrier = this.replayBarrier;
    if (!barrier) throw new Error('SSE replay did not start.');
    const result = await barrier.promise;
    if (result.status === 'error') throw result.error;
    if (result.status === 'reset') throw new SseReplayResetError();
    if (
      result.status === 'superseded' ||
      barrier !== this.replayBarrier ||
      barrier.generation !== this.generation
    ) {
      throw new Error('SSE replay was interrupted.');
    }
    return barrier.generation;
  }

  isReady(generation: number): boolean {
    const barrier = this.replayBarrier;
    return (
      this.source !== null &&
      this.generation === generation &&
      barrier?.generation === generation &&
      barrier.result?.status === 'ready'
    );
  }

  pause(status: SseConnectionStatus = 'offline'): void {
    this.closeSource(status === 'connecting' ? 'reset' : 'error');
    this.options.onStatus(status);
  }

  stop(): void {
    this.pause('offline');
  }

  private connect(): Promise<void> {
    if (this.source) return this.openPromise ?? Promise.resolve();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.options.onStatus('offline');
      return Promise.resolve();
    }

    const cursor = this.options.getCursor();
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const factory = this.options.eventSourceFactory ?? ((url: string) => new EventSource(url));
    const source = factory(`/api/events${query}`);
    const generation = ++this.generation;
    this.replaceReplayBarrier(generation);
    this.deliveryTail = Promise.resolve();
    this.source = source;
    this.options.onStatus('connecting');

    let rejectOpen!: (error: Error) => void;
    this.openPromise = new Promise<void>((resolve, reject) => {
      rejectOpen = reject;
      source.addEventListener(
        'open',
        () => {
          if (generation !== this.generation) return;
          this.options.onStatus('connected');
          this.armReplayTimeout(generation);
          resolve();
        },
        { once: true },
      );
    });

    source.addEventListener('change', (rawEvent) => {
      if (generation !== this.generation) return;
      const event = rawEvent as MessageEvent<string>;
      const batch = parseEvent(event, ChangeBatchSchema);
      if (!batch || !event.lastEventId) return;
      this.enqueueDelivery(generation, () => this.options.onChange(batch, event.lastEventId));
    });

    source.addEventListener('reset', (rawEvent) => {
      if (generation !== this.generation) return;
      const event = rawEvent as MessageEvent<string>;
      const reset = parseEvent(event, ResetEventSchema);
      if (!reset || !event.lastEventId) return;
      this.settleReplay(generation, { status: 'reset' });
      this.enqueueDelivery(generation, () => this.options.onReset(reset, event.lastEventId));
    });

    source.addEventListener('replay-ready', (rawEvent) => {
      if (generation !== this.generation) return;
      const event = rawEvent as MessageEvent<string>;
      const ready = parseEvent(event, SseReplayReadySchema);
      if (!ready || !event.lastEventId) return;
      this.enqueueDelivery(generation, () => {
        if (ready.cursor !== event.lastEventId || ready.cursor !== this.options.getCursor()) {
          throw new Error('SSE replay-ready cursor did not match the applied journal cursor.');
        }
        this.settleReplay(generation, { status: 'ready' });
      });
    });

    source.addEventListener('error', () => {
      if (generation !== this.generation) return;
      rejectOpen(new Error('SSE connection failed before replay was ready.'));
      this.options.onStatus(navigator.onLine ? 'error' : 'offline');
      this.closeSource('error');
    });

    return this.openPromise;
  }

  private enqueueDelivery(generation: number, operation: () => void | Promise<void>): void {
    const deliver = async (): Promise<void> => {
      if (generation !== this.generation) return;
      await operation();
    };
    this.deliveryTail = this.deliveryTail.then(deliver).catch((error: unknown) => {
      if (generation !== this.generation) return;
      this.settleReplay(generation, {
        status: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.options.onStatus(
        typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
      );
      this.closeSource('error');
    });
  }

  private replaceReplayBarrier(generation: number): void {
    if (this.replayBarrier && !this.replayBarrier.settled) {
      this.replayBarrier.settled = true;
      this.replayBarrier.resolve({ status: 'superseded' });
    }
    let resolve!: (result: ReplayResult) => void;
    const promise = new Promise<ReplayResult>((settle) => {
      resolve = settle;
    });
    this.replayBarrier = {
      generation,
      promise,
      resolve,
      settled: false,
      result: null,
      timeout: null,
    };
  }

  private settleReplay(generation: number, result: ReplayResult): void {
    const barrier = this.replayBarrier;
    if (!barrier || barrier.generation !== generation || barrier.settled) return;
    barrier.settled = true;
    barrier.result = result;
    if (barrier.timeout !== null) clearTimeout(barrier.timeout);
    barrier.timeout = null;
    barrier.resolve(result);
  }

  private armReplayTimeout(generation: number): void {
    const barrier = this.replayBarrier;
    if (!barrier || barrier.generation !== generation || barrier.settled) return;
    if (barrier.timeout !== null) clearTimeout(barrier.timeout);
    barrier.timeout = setTimeout(() => {
      if (generation !== this.generation || this.replayBarrier !== barrier || barrier.settled)
        return;
      this.options.onStatus('error');
      this.closeSource('error');
    }, REPLAY_READY_TIMEOUT_MS);
  }

  private closeSource(outcome?: 'reset' | 'superseded' | 'error'): void {
    const generation = this.generation;
    if (outcome) {
      this.settleReplay(
        generation,
        outcome === 'reset'
          ? { status: 'reset' }
          : outcome === 'superseded'
            ? { status: 'superseded' }
            : { status: 'error', error: new Error('SSE replay connection closed.') },
      );
    }
    this.generation += 1;
    this.source?.close();
    this.source = null;
    this.openPromise = null;
  }
}
