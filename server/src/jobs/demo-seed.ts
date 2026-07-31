import { ulid } from 'ulid';
import type { ActorContext } from '../domain/types.js';
import type { JournalDomain } from '../domain/journal.js';

export interface DemoSeedResult {
  readonly createdEntries: number;
  readonly collections: number;
  readonly summary: boolean;
}

/** Representative prototype data. It is reachable only through `seed --demo`. */
export function seedDemo(domain: JournalDomain): DemoSeedResult {
  const owner: ActorContext = { kind: 'owner', deviceId: ulid(), label: 'demo-seed' };
  const agent: ActorContext = {
    kind: 'agent',
    tokenId: ulid(),
    tokenLabel: 'demo-assistant',
    tool: 'add_entry',
  };
  const collections = [
    { id: 'books', name: 'Books to read', note: 'Reading list' },
    { id: 'ideas', name: 'Project ideas', note: 'Keep collections flat, no nesting' },
  ] as const;
  for (const collection of collections) domain.createCollection(collection, owner);

  const entries = [
    {
      date: '2026-07-28',
      type: 'task' as const,
      text: 'Book flights for Lisbon',
      tags: ['travel'],
    },
    {
      date: '2026-07-29',
      type: 'event' as const,
      text: 'Call with Anders',
      time: '14:30',
      tags: ['work'],
    },
    {
      date: '2026-07-30',
      type: 'task' as const,
      text: 'Confirm Lisbon apartment',
      tags: ['travel'],
    },
    { date: '2026-07-31', type: 'habit' as const, text: 'Walk after lunch', tags: ['health'] },
  ];
  let createdEntries = 0;
  for (const entry of entries) {
    if (
      domain
        .searchEntries({ query: entry.text, limit: 100 })
        .entries.some((candidate) => candidate.text === entry.text)
    ) {
      continue;
    }
    domain.createEntry({ id: ulid(), ...entry }, owner);
    createdEntries++;
  }
  if (
    !domain
      .searchEntries({ query: 'Pack passport and charger', limit: 100 })
      .entries.some((entry) => entry.text === 'Pack passport and charger')
  ) {
    domain.createEntry(
      {
        id: ulid(),
        date: '2026-07-31',
        type: 'task',
        text: 'Pack passport and charger',
        tags: ['travel'],
        source: 'From the Lisbon travel planning email.',
      },
      agent,
    );
    createdEntries++;
  }

  const beforeSummary = domain
    .listSummaries()
    .some((summary) => summary.weekStart === '2026-07-27');
  if (!beforeSummary) {
    domain.fileSummary(
      {
        weekStart: '2026-07-27',
        text: 'Travel planning moved forward; the unfinished logistics are clear enough to decide today.',
        source: 'Demo weekly synthesis from entries dated July 27–31.',
      },
      { ...agent, tool: 'add_entry' },
    );
  }
  return { createdEntries, collections: collections.length, summary: !beforeSummary };
}
