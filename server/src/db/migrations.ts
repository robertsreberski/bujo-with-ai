import { readFileSync } from 'node:fs';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
}

/**
 * Declares that this runtime can safely open a database with a contiguous
 * suffix of newer, additive migrations. Release tooling requires this marker
 * on the rollback runtime before permitting an append-only schema upgrade.
 */
export const MIGRATION_COMPATIBILITY_PROTOCOL = 1;

function migration(version: number, name: string, filename: string): Migration {
  const url = new URL(`./migrations/${filename}`, import.meta.url);
  try {
    return { version, name, filename, sql: readFileSync(url, 'utf8') };
  } catch (error) {
    throw new Error(`Required migration asset is missing: ${url.pathname}`, { cause: error });
  }
}

/** Numbered SQL files are authoritative and are copied beside compiled code. */
export const migrations: readonly Migration[] = [
  migration(1, 'core', '001_core.sql'),
  migration(2, 'fts', '002_fts.sql'),
  migration(3, 'entry-page', '003_entry_page.sql'),
  migration(4, 'saved-views', '004_saved_views.sql'),
  migration(5, 'reflections', '005_reflections.sql'),
  migration(6, 'reflection-source-bindings', '006_reflection_source_bindings.sql'),
];
