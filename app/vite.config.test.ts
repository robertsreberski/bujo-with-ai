import { describe, expect, it } from 'vitest';

import { journalShellRevision } from './vite.config';

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
