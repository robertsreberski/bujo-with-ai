import { afterEach, describe, expect, it, vi } from 'vitest';

import { SingleRecordPersistence } from './persistence';

describe('SingleRecordPersistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues immutable snapshots in order without cloning on the synchronous call path', async () => {
    const persistence = new SingleRecordPersistence<{ draft: string; outbox: string[] }>(null);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const first = { draft: 'one', outbox: ['a'] };
    const second = { draft: 'two', outbox: [...first.outbox, 'b'] };

    const firstSave = persistence.save(first);
    const secondSave = persistence.save(second);

    expect(clone).not.toHaveBeenCalled();
    await Promise.all([firstSave, secondSave]);

    expect(clone.mock.calls.map(([value]) => value)).toEqual([first, second]);
    expect(await persistence.load()).toEqual({ draft: 'two', outbox: ['a', 'b'] });
  });

  it('keeps a 10,000-entry mirror to one atomic queued write', async () => {
    const persistence = new SingleRecordPersistence<{
      entriesById: Record<string, { id: string; text: string }>;
    }>(null);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const entriesById = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => {
        const id = `entry-${String(index).padStart(5, '0')}`;
        return [id, { id, text: `Entry ${index}` }];
      }),
    );

    await persistence.save({ entriesById });

    expect(clone).toHaveBeenCalledTimes(1);
    expect(Object.keys((await persistence.load())?.entriesById ?? {})).toHaveLength(10_000);
  });
});
