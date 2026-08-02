import { describe, expect, it } from 'vitest';

import {
  deriveTagUsage,
  journalActions,
  mergeTagUsage,
  parseJournalSearch,
  selectActivity,
  selectJournalStatus,
  selectTimelineEntries,
} from './journal-store';
import {
  deriveTagUsage as featureDeriveTagUsage,
  mergeTagUsage as featureMergeTagUsage,
  selectActivity as featureSelectActivity,
} from './activity-enrichment';
import { selectJournalStatus as featureSelectJournalStatus } from './connection-outbox';
import {
  parseJournalSearch as featureParseJournalSearch,
  selectTimelineEntries as featureSelectTimelineEntries,
} from './timeline-retrieval';

const rawModules = import.meta.glob(
  [
    './*.ts',
    '../components/**/*.ts',
    '../components/**/*.tsx',
    '../domain/**/*.ts',
    '../views/**/*.ts',
    '../views/**/*.tsx',
  ],
  {
    eager: true,
    import: 'default',
    query: '?raw',
  },
) as Record<string, string>;

const featureModules = [
  'activity-enrichment',
  'connection-outbox',
  'recovery',
  'settings-pairing',
  'timeline-retrieval',
] as const;

function moduleId(path: string): string {
  const rooted = path.startsWith('./') ? `store/${path.slice(2)}` : path.slice(3);
  return rooted.replace(/\.(?:ts|tsx)$/, '');
}

function productionSources(): Map<string, string> {
  return new Map(
    Object.entries(rawModules)
      .filter(([path]) => !/\.test\.(?:ts|tsx)$/.test(path))
      .map(([path, source]) => [moduleId(path), source]),
  );
}

/** Static, type-only, side-effect, re-export, and dynamic string-literal imports. */
function importSpecifiers(source: string): string[] {
  const staticImports = [
    ...source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g),
  ].map((match) => match[1]!);
  const dynamicImports = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => match[1]!,
  );
  return [...staticImports, ...dynamicImports];
}

function resolveImport(module: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const parts = module.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/').replace(/\.(?:ts|tsx)$/, '');
}

function localImports(module: string, source: string, sources: Map<string, string>): string[] {
  return importSpecifiers(source)
    .map((specifier) => resolveImport(module, specifier))
    .filter((dependency): dependency is string => dependency !== null && sources.has(dependency));
}

describe('store feature boundaries', () => {
  it('recognizes every supported source import form', () => {
    expect(
      importSpecifiers(`
        import type { Alpha } from './alpha';
        import { beta } from './beta';
        import './side-effect';
        export type { Delta } from './delta';
        const gamma = import('./gamma');
      `),
    ).toEqual(['./alpha', './beta', './side-effect', './delta', './gamma']);
  });

  it('keeps journal-store as the stable public facade', () => {
    expect(parseJournalSearch).toBe(featureParseJournalSearch);
    expect(deriveTagUsage).toBe(featureDeriveTagUsage);
    expect(mergeTagUsage).toBe(featureMergeTagUsage);
    expect(selectActivity).toBe(featureSelectActivity);
    expect(selectJournalStatus).toBe(featureSelectJournalStatus);
    expect(selectTimelineEntries).toBe(featureSelectTimelineEntries);

    expect(Object.keys(journalActions).sort()).toEqual(
      [
        'activateUpdate',
        'createCollection',
        'createEntry',
        'createToken',
        'deleteEntry',
        'discardDeadLetter',
        'dismissMonthReview',
        'flush',
        'focusComposer',
        'initialize',
        'loadCollection',
        'loadDate',
        'loadEarlierTimeline',
        'loadEntries',
        'loadEntry',
        'loadIndex',
        'loadMonth',
        'loadMoreActivity',
        'loadRecovery',
        'loadReflections',
        'loadTagSuggestions',
        'loadTimeline',
        'markActivityVisible',
        'markAllActivitySeen',
        'markReviewSeen',
        'migrateEntry',
        'reconnect',
        'refreshTokens',
        'requestReflection',
        'restoreEntry',
        'restoreReflectionVersion',
        'retryDeadLetter',
        'retryLocalSave',
        'retryReflection',
        'revertActivity',
        'revokeToken',
        'rewriteSummary',
        'saveSummary',
        'scheduleEntry',
        'searchEntries',
        'setCollectionLogView',
        'setDefaultType',
        'setDraft',
        'setMonthLogView',
        'shutdown',
        'toggleEntry',
        'updateCollection',
        'updateEntry',
        'updateSettings',
      ].sort(),
    );
  });

  it('has an acyclic production import graph with sibling features isolated', () => {
    const sources = productionSources();
    const storeSources = new Map([...sources].filter(([module]) => module.startsWith('store/')));
    const graph = new Map(
      [...storeSources].map(([module, source]) => [
        module,
        localImports(module, source, sources).filter((dependency) => storeSources.has(dependency)),
      ]),
    );

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (module: string, path: string[]): void => {
      if (visiting.has(module))
        throw new Error(`Store import cycle: ${[...path, module].join(' -> ')}`);
      if (visited.has(module)) return;
      visiting.add(module);
      for (const dependency of graph.get(module) ?? []) visit(dependency, [...path, module]);
      visiting.delete(module);
      visited.add(module);
    };
    for (const module of graph.keys()) visit(module, []);

    const facade = sources.get('store/journal-store')!;
    const facadeImports = localImports('store/journal-store', facade, sources);
    for (const feature of featureModules) {
      const featureId = `store/${feature}`;
      expect(facadeImports).toContain(featureId);
      const imports = localImports(featureId, sources.get(featureId)!, sources);
      expect(imports).not.toContain('store/journal-store');
      expect(
        imports.filter((dependency) =>
          featureModules.some((candidate) => dependency === `store/${candidate}`),
        ),
      ).toEqual([]);
    }

    for (const core of ['models', 'optimistic', 'persistence', 'runtime', 'state', 'sse-client']) {
      expect(
        localImports(`store/${core}`, sources.get(`store/${core}`)!, sources).filter((dependency) =>
          featureModules.some((candidate) => dependency === `store/${candidate}`),
        ),
      ).toEqual([]);
    }
  });

  it('keeps domain, store, and presentation dependency directions honest', () => {
    const sources = productionSources();
    const violations: string[] = [];
    for (const [module, source] of sources) {
      const dependencies = localImports(module, source, sources);
      for (const dependency of dependencies) {
        if (
          module.startsWith('store/') &&
          (dependency.startsWith('components/') || dependency.startsWith('views/'))
        ) {
          violations.push(`${module} -> ${dependency}`);
        }
        if (
          (module.startsWith('components/') || module.startsWith('views/')) &&
          dependency.startsWith('store/')
        ) {
          violations.push(`${module} -> ${dependency}`);
        }
        if (
          module.startsWith('domain/') &&
          (dependency.startsWith('components/') ||
            dependency.startsWith('views/') ||
            dependency.startsWith('store/'))
        ) {
          violations.push(`${module} -> ${dependency}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('gives each action feature a narrow runtime state projection', () => {
    const sources = productionSources();
    for (const feature of featureModules) {
      expect(sources.get(`store/${feature}`)).not.toMatch(/\bJournalState\b/);
    }
    for (const feature of [
      'activity-enrichment',
      'recovery',
      'settings-pairing',
      'timeline-retrieval',
    ]) {
      expect(sources.get(`store/${feature}`)).toMatch(/JournalFeatureRuntime<\w+State>/);
    }
  });
});
