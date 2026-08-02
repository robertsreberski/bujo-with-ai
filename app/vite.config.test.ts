import { describe, expect, it } from 'vitest';

import {
  APP_ENTRY_RAW_BUDGET_BYTES,
  DEFAULT_TIMELINE_RAW_BUDGET_BYTES,
  PRECACHE_RAW_BUDGET_BYTES,
  appEntryStaticGraph,
  defaultTimelineRouteGraph,
  emittedPrecacheEntries,
  journalShellRevision,
  precacheInstallGraph,
} from './vite.config';

describe('journalShellRevision', () => {
  it('is stable when Rollup enumerates the same asset graph in a different order', () => {
    const assets = [
      { url: '/assets/app.js', revision: 'same-js' },
      { url: '/assets/app.css', revision: 'same-css' },
    ];

    expect(journalShellRevision('<title>Journal</title>', assets)).toBe(
      journalShellRevision('<title>Journal</title>', [...assets].reverse()),
    );
  });

  it('changes for shell-only edits even when the emitted asset graph is unchanged', () => {
    const assets = [{ url: '/assets/app.js', revision: 'same-js' }];

    expect(journalShellRevision('<title>Journal</title>', assets)).not.toBe(
      journalShellRevision('<title>Journal home</title>', assets),
    );
  });
});

describe('production asset boundaries', () => {
  it('counts the complete static app graph but excludes dynamic routes', () => {
    const graph = appEntryStaticGraph([
      {
        type: 'chunk',
        fileName: 'assets/app.js',
        name: 'app',
        isEntry: true,
        imports: ['assets/vendor.js'],
        code: 'app',
      },
      {
        type: 'chunk',
        fileName: 'assets/vendor.js',
        name: 'vendor',
        isEntry: false,
        imports: [],
        code: 'vendor',
      },
      {
        type: 'chunk',
        fileName: 'assets/MonthView.js',
        name: 'MonthView',
        isEntry: false,
        imports: [],
        code: 'lazy route',
      },
    ]);

    expect(graph).toEqual({ bytes: 9, files: ['assets/app.js', 'assets/vendor.js'] });
    expect(graph.bytes).toBeLessThan(APP_ENTRY_RAW_BUDGET_BYTES);
  });

  it('bounds the default usable Timeline graph across the lazy boundary', () => {
    const graph = defaultTimelineRouteGraph([
      {
        type: 'chunk',
        fileName: 'assets/app.js',
        name: 'app',
        isEntry: true,
        imports: ['assets/vendor.js'],
        code: 'app',
      },
      {
        type: 'chunk',
        fileName: 'assets/vendor.js',
        name: 'vendor',
        isEntry: false,
        imports: [],
        code: 'vendor',
      },
      {
        type: 'chunk',
        fileName: 'assets/TimelineView.js',
        name: 'TimelineView',
        isEntry: false,
        imports: ['assets/EntryRow.js'],
        code: 'timeline',
      },
      {
        type: 'chunk',
        fileName: 'assets/EntryRow.js',
        name: 'EntryRow',
        isEntry: false,
        imports: ['assets/vendor.js'],
        code: 'row',
      },
      {
        type: 'chunk',
        fileName: 'assets/SettingsDialog.js',
        name: 'SettingsDialog',
        isEntry: false,
        imports: [],
        code: 'unrelated route',
      },
    ]);

    expect(graph).toEqual({
      bytes: 20,
      files: ['assets/EntryRow.js', 'assets/TimelineView.js', 'assets/app.js', 'assets/vendor.js'],
    });
    expect(graph.bytes).toBeLessThan(DEFAULT_TIMELINE_RAW_BUDGET_BYTES);
  });

  it('precaches lazy chunks as first-class build assets', () => {
    const manifest = emittedPrecacheEntries([
      { type: 'chunk', fileName: 'assets/app.js', code: 'app' },
      { type: 'chunk', fileName: 'assets/MonthView.js', code: 'lazy route' },
      { type: 'chunk', fileName: 'sw.js', code: 'worker' },
    ]);

    expect(manifest.map((entry) => entry.url)).toEqual(['/assets/app.js', '/assets/MonthView.js']);
  });

  it('bounds the whole offline install payload and de-duplicates public assets', () => {
    const graph = precacheInstallGraph(
      [
        { type: 'chunk', fileName: 'assets/app.js', code: 'app' },
        { type: 'chunk', fileName: 'assets/TimelineView.js', code: 'timeline' },
        { type: 'asset', fileName: 'icons/icon.png', source: 'emitted icon' },
        { type: 'chunk', fileName: 'sw.js', code: 'not precached' },
        { type: 'asset', fileName: 'assets/app.js.map', source: 'not precached' },
      ],
      [
        { url: '/icons/icon.png', source: 'public icon' },
        { url: '/index.html', source: 'shell' },
      ],
    );

    expect(graph).toEqual({
      bytes: 27,
      files: ['/assets/TimelineView.js', '/assets/app.js', '/icons/icon.png', '/index.html'],
    });
    expect(graph.bytes).toBeLessThan(PRECACHE_RAW_BUDGET_BYTES);
  });
});
