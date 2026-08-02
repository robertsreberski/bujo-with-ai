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

const rawModules = import.meta.glob('./*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

const featureModules = [
  'activity-enrichment',
  'connection-outbox',
  'recovery',
  'settings-pairing',
  'timeline-retrieval',
] as const;

function productionSources(): Map<string, string> {
  return new Map(
    Object.entries(rawModules)
      .filter(([path]) => !path.endsWith('.test.ts'))
      .map(([path, source]) => [path.slice(2, -3), source]),
  );
}

function localImports(source: string): string[] {
  return [...source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map((match) =>
    match[1]!.replace(/\.ts$/, ''),
  );
}

describe('store feature boundaries', () => {
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
    const graph = new Map(
      [...sources].map(([module, source]) => [
        module,
        localImports(source).filter((dependency) => sources.has(dependency)),
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

    const facade = sources.get('journal-store')!;
    for (const feature of featureModules) {
      expect(localImports(facade)).toContain(feature);
      const imports = localImports(sources.get(feature)!);
      expect(imports).not.toContain('journal-store');
      expect(imports.filter((dependency) => featureModules.includes(dependency as never))).toEqual(
        [],
      );
    }

    for (const core of ['models', 'optimistic', 'persistence', 'runtime', 'state', 'sse-client']) {
      expect(
        localImports(sources.get(core)!).filter((dependency) =>
          featureModules.includes(dependency as never),
        ),
      ).toEqual([]);
    }
  });
});
