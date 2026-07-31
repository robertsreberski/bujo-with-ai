// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JournalSseClient, SseReplayResetError } from './sse-client';

class FakeEventSource extends EventTarget {
  readonly url: string;
  close = vi.fn();

  constructor(url: string) {
    super();
    this.url = url;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('JournalSseClient', () => {
  it('reconnects from the epoch cursor and validates complete batches', async () => {
    const sources: FakeEventSource[] = [];
    let cursor = 'server-epoch:4';
    const onChange = vi.fn((_batch: unknown, nextCursor: string) => {
      cursor = nextCursor;
    });
    const client = new JournalSseClient({
      getCursor: () => cursor,
      onChange,
      onReset: vi.fn(),
      onStatus: vi.fn(),
      eventSourceFactory: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    });

    const opening = client.start();
    const source = sources[0];
    expect(source?.url).toBe('/api/events?cursor=server-epoch%3A4');
    source?.dispatchEvent(new Event('open'));
    await opening;

    source?.dispatchEvent(
      new MessageEvent('change', {
        lastEventId: 'server-epoch:5',
        data: JSON.stringify({
          transactionId: '01K1H000000000000000000001',
          mutationId: null,
          origin: { kind: 'system' },
          changes: [
            {
              kind: 'summary.changed',
              payload: { id: '01K1H000000000000000000002' },
            },
          ],
        }),
      }),
    );
    source?.dispatchEvent(new MessageEvent('change', { lastEventId: 'bad', data: '{}' }));
    source?.dispatchEvent(
      new MessageEvent('replay-ready', {
        lastEventId: 'server-epoch:5',
        data: JSON.stringify({ cursor: 'server-epoch:5' }),
      }),
    );

    await client.finishReplay();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: '01K1H000000000000000000001' }),
      'server-epoch:5',
    );
    client.stop();
  });

  it('fails and closes a replay-ready stream when a later async change handler rejects', async () => {
    const sources: FakeEventSource[] = [];
    const onStatus = vi.fn();
    let rejectChange!: (reason: unknown) => void;
    const rejectedChange = new Promise<void>((_resolve, reject) => {
      rejectChange = reject;
    });
    const onChange = vi.fn(() => rejectedChange);
    const client = new JournalSseClient({
      getCursor: () => 'server-epoch:4',
      onChange,
      onReset: vi.fn(),
      onStatus,
      eventSourceFactory: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    });

    const opening = client.start();
    sources[0]?.dispatchEvent(new Event('open'));
    await opening;
    sources[0]?.dispatchEvent(
      new MessageEvent('replay-ready', {
        lastEventId: 'server-epoch:4',
        data: JSON.stringify({ cursor: 'server-epoch:4' }),
      }),
    );
    const readyGeneration = await client.finishReplay();

    sources[0]?.dispatchEvent(
      new MessageEvent('change', {
        lastEventId: 'server-epoch:5',
        data: JSON.stringify({
          transactionId: '01K1H000000000000000000003',
          mutationId: null,
          origin: { kind: 'system' },
          changes: [
            {
              kind: 'summary.changed',
              payload: { id: '01K1H000000000000000000004' },
            },
          ],
        }),
      }),
    );
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    rejectChange(new Error('Could not persist the live change.'));

    await vi.waitFor(() => expect(sources[0]?.close).toHaveBeenCalledTimes(1));
    expect(onStatus).toHaveBeenLastCalledWith('error');
    expect(client.isReady(readyGeneration)).toBe(false);

    const replacementOpening = client.start();
    expect(sources).toHaveLength(2);
    sources[1]?.dispatchEvent(new Event('open'));
    await replacementOpening;
    client.stop();
  });

  it('rejects the terminal reset generation and ignores its queued ready marker', async () => {
    const sources: FakeEventSource[] = [];
    let cursor = 'old-epoch:7';
    let releaseHydration!: () => void;
    const hydration = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const client = new JournalSseClient({
      getCursor: () => cursor,
      onChange: vi.fn(),
      onReset: async () => {
        client.pause('connecting');
        await hydration;
        cursor = 'new-epoch:20';
        await client.start();
      },
      onStatus: vi.fn(),
      eventSourceFactory: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    });

    const opening = client.start();
    sources[0]?.dispatchEvent(new Event('open'));
    await opening;
    const terminalReplay = client.finishReplay();
    sources[0]?.dispatchEvent(
      new MessageEvent('reset', {
        lastEventId: 'new-epoch:20',
        data: JSON.stringify({
          reason: 'server_restarted',
          currentCursor: 'new-epoch:20',
        }),
      }),
    );
    sources[0]?.dispatchEvent(
      new MessageEvent('replay-ready', {
        lastEventId: 'new-epoch:20',
        data: JSON.stringify({ cursor: 'new-epoch:20' }),
      }),
    );

    await expect(terminalReplay).rejects.toBeInstanceOf(SseReplayResetError);
    releaseHydration();
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    sources[1]?.dispatchEvent(new Event('open'));
    await vi.waitFor(() => expect(sources[1]?.url).toContain('new-epoch%3A20'));

    let replacementReady = false;
    const replacementReplay = client.finishReplay().then(() => {
      replacementReady = true;
    });
    await Promise.resolve();
    expect(replacementReady).toBe(false);
    sources[1]?.dispatchEvent(
      new MessageEvent('replay-ready', {
        lastEventId: 'new-epoch:20',
        data: JSON.stringify({ cursor: 'new-epoch:20' }),
      }),
    );
    await replacementReplay;
    client.stop();
  });

  it('fails a stream that opens without a replay-ready marker and never retries internally', async () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const onStatus = vi.fn();
    const client = new JournalSseClient({
      getCursor: () => 'epoch:4',
      onChange: vi.fn(),
      onReset: vi.fn(),
      onStatus,
      eventSourceFactory: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    });

    const opening = client.start();
    sources[0]?.dispatchEvent(new Event('open'));
    await opening;
    const replayFailure = expect(client.finishReplay()).rejects.toThrow('closed');
    await vi.advanceTimersByTimeAsync(10_000);

    await replayFailure;
    expect(onStatus).toHaveBeenLastCalledWith('error');
    expect(sources[0]?.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources).toHaveLength(1);
  });

  it('rejects an error before open without scheduling an unhandled retry', async () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const client = new JournalSseClient({
      getCursor: () => null,
      onChange: vi.fn(),
      onReset: vi.fn(),
      onStatus: vi.fn(),
      eventSourceFactory: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    });

    const openingFailure = expect(client.start()).rejects.toThrow('failed before replay');
    const replayFailure = expect(client.finishReplay()).rejects.toThrow('closed');
    sources[0]?.dispatchEvent(new Event('error'));

    await openingFailure;
    await replayFailure;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources).toHaveLength(1);
  });
});
