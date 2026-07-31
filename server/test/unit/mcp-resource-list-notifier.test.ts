import { describe, expect, it } from 'vitest';
import { ResourceListNotifier } from '../../src/mcp/resource-list-notifier.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

describe('ResourceListNotifier', () => {
  it('coalesces a notification storm and closes each live stream after its send', async () => {
    const firstSend = deferred();
    let sends = 0;
    let closes = 0;
    const notifier = new ResourceListNotifier({
      send: async () => {
        sends += 1;
        if (sends === 1) await firstSend.promise;
      },
      closeStream: () => {
        closes += 1;
      },
      isActive: () => true,
    });

    notifier.notify();
    await Promise.resolve();
    expect(sends).toBe(1);
    for (let index = 0; index < 100_000; index += 1) notifier.notify();

    firstSend.resolve();
    await notifier.idle();
    expect(sends).toBe(2);
    expect(closes).toBe(2);
  });

  it('stops cleanly when an SDK send fails or the session becomes inactive', async () => {
    let active = true;
    let sends = 0;
    let closes = 0;
    const notifier = new ResourceListNotifier({
      send: async () => {
        sends += 1;
        throw new Error('transport closed');
      },
      closeStream: () => {
        closes += 1;
      },
      isActive: () => active,
    });

    notifier.notify();
    await notifier.idle();
    active = false;
    notifier.notify();
    expect(sends).toBe(1);
    expect(closes).toBe(0);
  });
});
