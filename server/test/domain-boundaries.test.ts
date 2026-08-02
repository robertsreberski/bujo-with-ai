import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import { JournalDatabase } from '../src/db/database.js';
import { JournalDomain } from '../src/domain/journal.js';
import type { ActorContext } from '../src/domain/types.js';

const roots: string[] = [];
const open: JournalDomain[] = [];

afterEach(() => {
  for (const domain of open.splice(0)) domain.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'journal-domain-boundary-test-'));
  roots.push(root);
  let instant = new Date('2026-07-31T10:00:00.000Z');
  const database = new JournalDatabase({ path: join(root, 'journal.db'), now: () => instant });
  const domain = new JournalDomain({
    database,
    config: { timezone: 'UTC', dayBoundaryOffsetMin: 0, deviceCredentialTtlDays: 365 },
    now: () => instant,
  });
  open.push(domain);
  const owner: ActorContext = { kind: 'owner', deviceId: ulid() };
  const agent: ActorContext = {
    kind: 'agent',
    tokenId: ulid(),
    tokenLabel: 'boundary-agent',
    tool: 'add_entry',
  };
  return {
    database,
    domain,
    owner,
    agent,
    advance(milliseconds: number) {
      instant = new Date(instant.getTime() + milliseconds);
    },
  };
}

describe('JournalDomain transaction boundaries', () => {
  it('rolls back an entry, Reflection staleness, idempotency, and emission together', () => {
    const { database, domain, owner, agent } = fixture();
    const created = domain.createEntry(
      {
        id: ulid(),
        date: '2026-07-21',
        type: 'note',
        text: 'Original bounded Reflection source',
      },
      owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected source entry');
    const filed = domain.fileSummary(
      {
        weekStart: '2026-07-20',
        text: 'A current weekly Reflection.',
        source: 'Bounded Reflection transaction fixture.',
      },
      agent,
    );
    const reflection = domain.listReflections('2026-07-20', '2026-07-26')[0];
    if (reflection === undefined) throw new Error('Expected current Reflection');
    expect(reflection.status).toBe('current');

    const beforeEntry = domain.requireEntry(created.entry.id);
    const beforeSummary = domain.getSummary(filed.summary.id);
    const batches: unknown[] = [];
    domain.subscribe((batch) => batches.push(batch));
    database.raw.exec(`
      CREATE TRIGGER abort_reflection_staleness
      BEFORE UPDATE OF status ON reflection_slots
      WHEN NEW.status = 'stale'
      BEGIN
        SELECT RAISE(ABORT, 'abort reflection staleness');
      END
    `);

    expect(() =>
      domain.updateEntry(created.entry.id, { text: 'This edit must roll back' }, owner, {
        id: 'rollback-staleness-1',
      }),
    ).toThrowError(/abort reflection staleness/i);

    expect(domain.requireEntry(created.entry.id)).toEqual(beforeEntry);
    expect(domain.getReflection(reflection.id)).toEqual(reflection);
    expect(domain.getSummary(filed.summary.id)).toEqual(beforeSummary);
    expect(
      database.raw
        .prepare('SELECT count(*) FROM processed_mutations WHERE mutation_id = ?')
        .pluck()
        .get('rollback-staleness-1'),
    ).toBe(0);
    expect(batches).toEqual([]);
  });

  it('rolls audit and idempotency redaction back when recovery purge cannot delete', () => {
    const { database, domain, agent, advance } = fixture();
    const sentinel = 'Rollback keeps this expired audit content intact';
    const created = domain.createEntry(
      {
        id: ulid(),
        date: '2026-07-31',
        type: 'note',
        text: sentinel,
        source: 'Recovery purge transaction fixture.',
      },
      agent,
      { id: 'rollback-purge-create' },
    );
    if (created.kind !== 'entry') throw new Error('Expected agent entry');
    domain.deleteEntry(
      created.entry.id,
      agent,
      { id: 'rollback-purge-delete' },
      {
        expectedRevision: created.entry.revision,
        reason: 'Exercise purge rollback.',
      },
    );
    advance(30 * 86_400_000 + 1);
    const beforeActivity = database.raw
      .prepare('SELECT id, text, pre_images, post_images FROM activity ORDER BY id')
      .all();
    const beforeMutations = database.raw
      .prepare(
        `SELECT actor_type, actor_id, mutation_id, request_hash, result
         FROM processed_mutations ORDER BY mutation_id`,
      )
      .all();
    expect(JSON.stringify(beforeActivity)).toContain(sentinel);
    expect(JSON.stringify(beforeMutations)).toContain(sentinel);
    database.raw.exec(`
      CREATE TRIGGER abort_expired_entry_delete
      BEFORE DELETE ON entries
      BEGIN
        SELECT RAISE(ABORT, 'abort expired entry delete');
      END
    `);

    expect(() => domain.purgeExpired()).toThrowError(/abort expired entry delete/i);

    expect(domain.getEntry(created.entry.id, { includeDeleted: true })).not.toBeNull();
    const afterActivity = database.raw
      .prepare('SELECT id, text, pre_images, post_images FROM activity ORDER BY id')
      .all();
    expect(afterActivity).toEqual(beforeActivity);
    expect(JSON.stringify(afterActivity)).toContain(sentinel);
    expect(
      database.raw
        .prepare(
          `SELECT actor_type, actor_id, mutation_id, request_hash, result
           FROM processed_mutations ORDER BY mutation_id`,
        )
        .all(),
    ).toEqual(beforeMutations);
  });
});

describe('server domain import graph', () => {
  it('keeps extracted features as sibling-free leaves behind the JournalDomain facade', () => {
    const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
    const domainRoot = join(sourceRoot, 'domain');
    const files = sourceFiles(domainRoot);
    const graph = new Map(files.map((file) => [file, relativeTypeScriptImports(file)]));
    const featureNames = [
      'entry-commands.ts',
      'timeline-queries.ts',
      'collection-recovery.ts',
      'activity-reflection.ts',
    ];
    const features = new Set(featureNames.map((name) => join(domainRoot, name)));
    const kernel = join(domainRoot, 'kernel.ts');
    const journal = join(domainRoot, 'journal.ts');

    for (const feature of features) {
      const imports = graph.get(feature) ?? [];
      expect(imports, `${basename(feature)} must not import journal.ts`).not.toContain(journal);
      expect(
        imports.filter((dependency) => features.has(dependency)),
        `${basename(feature)} must not import a sibling feature`,
      ).toEqual([]);
      expect(imports, `${basename(feature)} must use the neutral kernel`).toContain(kernel);
    }
    expect(graph.get(kernel) ?? []).not.toContain(journal);
    expect((graph.get(kernel) ?? []).filter((dependency) => features.has(dependency))).toEqual([]);
    expect(
      (graph.get(journal) ?? []).filter((dependency) => features.has(dependency)).sort(),
    ).toEqual([...features].sort());
    expect(findCycles(graph)).toEqual([]);

    const forbiddenOutsideDomain = new Set([...features, kernel]);
    const outsideImports = sourceFiles(sourceRoot)
      .filter((file) => !file.startsWith(`${domainRoot}/`))
      .flatMap((file) =>
        relativeTypeScriptImports(file)
          .filter((dependency) => forbiddenOutsideDomain.has(dependency))
          .map((dependency) => `${file} -> ${dependency}`),
      );
    expect(outsideImports, 'production consumers must stay behind JournalDomain').toEqual([]);
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    })
    .sort();
}

function relativeTypeScriptImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports: string[] = [];
  for (const statement of source.statements) {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.startsWith('.')) continue;
    const resolved = resolve(
      dirname(file),
      specifier.text.replace(/\.js$/u, '.ts').replace(/\/index\.ts$/u, '.ts'),
    );
    const candidate = existsSync(resolved)
      ? resolved
      : existsSync(join(resolved.replace(/\.ts$/u, ''), 'index.ts'))
        ? join(resolved.replace(/\.ts$/u, ''), 'index.ts')
        : null;
    if (candidate !== null) imports.push(candidate);
  }
  return imports;
}

function findCycles(graph: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const visit = (node: string): void => {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      cycles.add([...stack.slice(start), node].map(basename).join(' -> '));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) {
      if (graph.has(dependency)) visit(dependency);
    }
    stack.pop();
    active.delete(node);
  };
  for (const node of graph.keys()) visit(node);
  return [...cycles].sort();
}
