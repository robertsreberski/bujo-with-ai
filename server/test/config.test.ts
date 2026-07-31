import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('server configuration', () => {
  it('refuses a non-loopback bind even when supplied through the environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-config-test-'));
    try {
      expect(() =>
        loadConfig({
          configPath: join(root, 'missing-config.json'),
          env: { JOURNAL_BIND_HOST: '0.0.0.0', JOURNAL_DATA_DIR: root },
        }),
      ).toThrowError(/127\.0\.0\.1/);
      expect(
        loadConfig({
          configPath: join(root, 'missing-config.json'),
          env: { JOURNAL_BIND_HOST: '127.0.0.1', JOURNAL_DATA_DIR: root },
        }).bindHost,
      ).toBe('127.0.0.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
