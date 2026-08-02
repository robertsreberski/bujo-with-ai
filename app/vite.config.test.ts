import { describe, expect, it } from 'vitest';

import {
  APP_ENTRY_RAW_BUDGET_BYTES,
  appEntryStaticGraph,
  emittedPrecacheEntries,
  journalShellRevision,
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

  it('precaches lazy chunks as first-class build assets', () => {
    const manifest = emittedPrecacheEntries([
      { type: 'chunk', fileName: 'assets/app.js', code: 'app' },
      { type: 'chunk', fileName: 'assets/MonthView.js', code: 'lazy route' },
      { type: 'chunk', fileName: 'sw.js', code: 'worker' },
    ]);

    expect(manifest.map((entry) => entry.url)).toEqual(['/assets/app.js', '/assets/MonthView.js']);
  });
});
