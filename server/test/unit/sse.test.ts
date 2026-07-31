import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { SseHub, type ChangeBatch } from '../../src/api/sse.js';

describe('SseHub replay boundary', () => {
  it('marks replay ready before delivering a publish racing the live handoff', () => {
    const hub = new SseHub({ capacity: 2, epoch: 'test-epoch', heartbeatMs: 60_000 });
    const replayed: ChangeBatch = {
      transactionId: 'tx-replayed',
      mutationId: null,
      origin: { kind: 'system' },
      changes: [{ kind: 'entry.updated', payload: { text: 'replayed' } }],
    };
    const replayedSecond: ChangeBatch = {
      transactionId: 'tx-replayed-second',
      mutationId: null,
      origin: { kind: 'system' },
      changes: [{ kind: 'entry.updated', payload: { text: 'replayed second' } }],
    };
    const raced: ChangeBatch = {
      transactionId: 'tx-raced',
      mutationId: null,
      origin: { kind: 'system' },
      changes: [{ kind: 'entry.updated', payload: { text: 'raced' } }],
    };
    hub.publish(replayed);
    hub.publish(replayedSecond);

    const requestEvents = new EventEmitter();
    const responseEvents = new EventEmitter();
    const frames: string[] = [];
    let injectedRace = false;
    let writableEnded = false;
    const fakeRequest = Object.assign(requestEvents, {
      query: { cursor: 'test-epoch:0' },
      get: () => undefined,
    }) as unknown as Request;
    const fakeResponse = responseEvents as unknown as Response;
    Object.assign(fakeResponse, {
      destroyed: false,
      status: () => fakeResponse,
      set: () => fakeResponse,
      flushHeaders: () => undefined,
      write: (frame: string) => {
        frames.push(frame);
        if (!injectedRace && frame.startsWith('event: change')) {
          injectedRace = true;
          hub.publish(raced);
        }
        return true;
      },
      end: () => {
        writableEnded = true;
      },
    });
    Object.defineProperties(fakeResponse, {
      writableEnded: { get: () => writableEnded },
      writableLength: {
        get: () => frames.reduce((bytes, frame) => bytes + Buffer.byteLength(frame), 0),
      },
    });

    hub.handler(fakeRequest, fakeResponse, () => undefined);

    expect(frames.map((frame) => frame.match(/^event: (.+)$/m)?.[1])).toEqual([
      'change',
      'change',
      'replay-ready',
      'change',
    ]);
    expect(frames[0]).toContain('id: test-epoch:1');
    expect(frames[0]).toContain('tx-replayed');
    expect(frames[1]).toContain('id: test-epoch:2');
    expect(frames[1]).toContain('tx-replayed-second');
    expect(frames[2]).toBe(
      'event: replay-ready\nid: test-epoch:2\ndata: {"cursor":"test-epoch:2"}\n\n',
    );
    expect(frames[3]).toContain('id: test-epoch:3');
    expect(frames[3]).toContain('tx-raced');
    hub.close();
  });

  it('writes replay ready exactly once after a reset frame', () => {
    const hub = new SseHub({ epoch: 'current-epoch', heartbeatMs: 60_000 });
    const requestEvents = new EventEmitter();
    const responseEvents = new EventEmitter();
    const frames: string[] = [];
    let writableEnded = false;
    const fakeRequest = Object.assign(requestEvents, {
      query: { cursor: 'old-epoch:0' },
      get: () => undefined,
    }) as unknown as Request;
    const fakeResponse = responseEvents as unknown as Response;
    Object.assign(fakeResponse, {
      destroyed: false,
      status: () => fakeResponse,
      set: () => fakeResponse,
      flushHeaders: () => undefined,
      write: (frame: string) => {
        frames.push(frame);
        return true;
      },
      end: () => {
        writableEnded = true;
      },
    });
    Object.defineProperties(fakeResponse, {
      writableEnded: { get: () => writableEnded },
      writableLength: { get: () => 0 },
    });

    hub.handler(fakeRequest, fakeResponse, () => undefined);

    expect(frames.map((frame) => frame.match(/^event: (.+)$/m)?.[1])).toEqual([
      'reset',
      'replay-ready',
    ]);
    expect(frames[0]).toContain('id: current-epoch:0');
    expect(frames[0]).toContain('"currentCursor":"current-epoch:0"');
    expect(frames[1]).toBe(
      'event: replay-ready\nid: current-epoch:0\ndata: {"cursor":"current-epoch:0"}\n\n',
    );
    hub.close();
  });

  it('marks an already-current stream ready without advancing the cursor', () => {
    const hub = new SseHub({ epoch: 'test-epoch', heartbeatMs: 60_000 });
    hub.publish({
      transactionId: 'tx-current',
      mutationId: null,
      origin: { kind: 'system' },
      changes: [{ kind: 'entry.updated', payload: { text: 'current' } }],
    });
    const cursorBeforeConnect = hub.cursor;
    const requestEvents = new EventEmitter();
    const responseEvents = new EventEmitter();
    const frames: string[] = [];
    let writableEnded = false;
    const fakeRequest = Object.assign(requestEvents, {
      query: { cursor: cursorBeforeConnect },
      get: () => undefined,
    }) as unknown as Request;
    const fakeResponse = responseEvents as unknown as Response;
    Object.assign(fakeResponse, {
      destroyed: false,
      status: () => fakeResponse,
      set: () => fakeResponse,
      flushHeaders: () => undefined,
      write: (frame: string) => {
        frames.push(frame);
        return true;
      },
      end: () => {
        writableEnded = true;
      },
    });
    Object.defineProperties(fakeResponse, {
      writableEnded: { get: () => writableEnded },
      writableLength: { get: () => 0 },
    });

    hub.handler(fakeRequest, fakeResponse, () => undefined);

    expect(frames).toEqual([
      'event: replay-ready\nid: test-epoch:1\ndata: {"cursor":"test-epoch:1"}\n\n',
    ]);
    expect(hub.cursor).toBe(cursorBeforeConnect);
    hub.close();
  });
});

describe('SseHub backpressure', () => {
  it('disconnects a buffered client so later mutations cannot keep growing its queue', () => {
    const hub = new SseHub({
      capacity: 1,
      epoch: 'test-epoch',
      heartbeatMs: 60_000,
      maxClientBufferBytes: 1_000,
    });
    const requestEvents = new EventEmitter();
    const responseEvents = new EventEmitter();
    let writableLength = 0;
    let writableEnded = false;
    let writeCalls = 0;
    let ended = false;

    const fakeRequest = Object.assign(requestEvents, {
      query: {},
      get: () => undefined,
    }) as unknown as Request;
    const fakeResponse = responseEvents as unknown as Response;
    Object.assign(fakeResponse, {
      destroyed: false,
      status: () => fakeResponse,
      set: () => fakeResponse,
      flushHeaders: () => undefined,
      write: (frame: string) => {
        writeCalls += 1;
        writableLength += Buffer.byteLength(frame);
        return true;
      },
      end: () => {
        ended = true;
        writableEnded = true;
      },
    });
    Object.defineProperties(fakeResponse, {
      writableEnded: { get: () => writableEnded },
      writableLength: { get: () => writableLength },
    });
    hub.handler(fakeRequest, fakeResponse, () => undefined);

    const batch: ChangeBatch = {
      transactionId: 'tx-slow-client',
      mutationId: null,
      origin: { kind: 'system' },
      changes: [{ kind: 'entry.updated', payload: { text: 'x'.repeat(600) } }],
    };
    hub.publish(batch);
    expect(writeCalls).toBe(2);

    // The second frame would exceed the explicit per-client cap, so the hub
    // ends that stream without adding another byte to its pending buffer.
    hub.publish(batch);
    expect(ended).toBe(true);
    expect(writeCalls).toBe(2);
    expect(writableLength).toBeLessThanOrEqual(1_000);

    const startedAt = performance.now();
    for (let index = 0; index < 1_000; index += 1) hub.publish(batch);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(writeCalls).toBe(2);
    hub.close();
  });
});
