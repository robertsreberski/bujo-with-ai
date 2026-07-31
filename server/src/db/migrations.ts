import { readFileSync } from 'node:fs';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

function migration(version: number, name: string, filename: string): Migration {
  const url = new URL(`./migrations/${filename}`, import.meta.url);
  try {
    return { version, name, sql: readFileSync(url, 'utf8') };
  } catch (error) {
    throw new Error(`Required migration asset is missing: ${url.pathname}`, { cause: error });
  }
}

/** Numbered SQL files are authoritative and are copied beside compiled code. */
export const migrations: readonly Migration[] = [
  migration(1, 'core', '001_core.sql'),
  migration(2, 'fts', '002_fts.sql'),
  migration(3, 'entry-page', '003_entry_page.sql'),
];
