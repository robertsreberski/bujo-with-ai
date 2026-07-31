import { clear, createStore, get, set, type UseStore } from 'idb-keyval';

export interface AtomicRecordPersistence<T> {
  load(): Promise<T | undefined>;
  save(value: T): Promise<void>;
  clear(): Promise<void>;
}

const DATABASE_NAME = 'journal-pwa';
const OBJECT_STORE_NAME = 'client-state';
const RECORD_KEY = 'journal-client-state-v1';

/**
 * Persists the entire mirror, draft and mutation ledger under one IndexedDB key.
 * Each optimistic transition is therefore crash-consistent rather than spread
 * across independently committed stores.
 */
export class SingleRecordPersistence<T> implements AtomicRecordPersistence<T> {
  private readonly store: UseStore | null;
  private memoryValue: T | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(store?: UseStore | null) {
    this.store =
      store === undefined
        ? typeof globalThis.indexedDB === 'undefined'
          ? null
          : createStore(DATABASE_NAME, OBJECT_STORE_NAME)
        : store;
  }

  async load(): Promise<T | undefined> {
    await this.tail.catch(() => undefined);
    if (!this.store) return this.memoryValue;
    return get<T>(RECORD_KEY, this.store);
  }

  save(value: T): Promise<void> {
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (!this.store) {
          this.memoryValue = structuredClone(value);
          return;
        }
        // IndexedDB performs its own structured clone when the queued write is
        // issued. Callers pass immutable state snapshots, so deferring that work
        // keeps cloning out of the capture event's synchronous paint path.
        await set(RECORD_KEY, value, this.store);
      });
    return this.tail;
  }

  clear(): Promise<void> {
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        this.memoryValue = undefined;
        if (this.store) await clear(this.store);
      });
    return this.tail;
  }
}
