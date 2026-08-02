import { describe, expect, it } from 'vitest';

import { selectJournalStatus, useJournalStore, type JournalState } from './journal-store';

const project = (overrides: Partial<JournalState> = {}) =>
  selectJournalStatus({
    ...useJournalStore.getState(),
    hydrated: true,
    loading: false,
    resourceStatus: 'ready',
    networkOnline: true,
    online: true,
    connectionStatus: 'connected',
    authenticationRequired: false,
    persistenceStatus: 'available',
    syncing: false,
    outbox: [],
    outboxCount: 0,
    deadLetters: [],
    ...overrides,
  });

describe('selectJournalStatus', () => {
  it('keeps resource loading separate from a transport that happens to be open', () => {
    expect(
      project({
        hydrated: true,
        resourceStatus: 'loading',
        connectionStatus: 'connected',
        online: true,
      }),
    ).toMatchObject({ resource: 'loading', connection: 'initializing' });
  });

  it.each([
    ['online', {}, 'online'],
    ['reconnecting', { connectionStatus: 'connecting', online: false }, 'reconnecting'],
    ['offline', { networkOnline: false, online: false }, 'offline'],
    ['server unavailable', { connectionStatus: 'error', online: false }, 'serverUnavailable'],
    [
      'authentication required',
      { connectionStatus: 'error', online: false, authenticationRequired: true },
      'authenticationRequired',
    ],
  ] as const)('projects %s explicitly', (_label, overrides, connection) => {
    expect(project(overrides).connection).toBe(connection);
  });

  it('projects pending and actively syncing changes independently of connection state', () => {
    expect(project({ networkOnline: false, online: false, outboxCount: 2 })).toMatchObject({
      connection: 'offline',
      synchronization: 'pending',
      pendingChanges: 2,
    });
    expect(project({ syncing: true, outboxCount: 2 })).toMatchObject({
      connection: 'online',
      synchronization: 'syncing',
      pendingChanges: 2,
    });
  });

  it('keeps failed-change attention visible even while another mutation is syncing', () => {
    expect(
      project({
        syncing: true,
        outboxCount: 1,
        deadLetters: [{} as JournalState['deadLetters'][number]],
      }),
    ).toMatchObject({
      synchronization: 'attention',
      pendingChanges: 1,
      failedChanges: 1,
    });
  });

  it('treats failed durable storage as synchronization attention', () => {
    expect(project({ persistenceStatus: 'unavailable', outboxCount: 1 })).toMatchObject({
      synchronization: 'attention',
      persistence: 'unavailable',
      pendingChanges: 1,
    });
  });
});
