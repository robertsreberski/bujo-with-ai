import {
  CalendarDateSchema,
  CaptureRequestSchema,
  CreateCollectionRequestSchema,
  CreateEntryRequestSchema,
  EntryQuerySchema,
  IsoTimestampSchema,
  MigrateEntryRequestSchema,
  ScheduleMonthlyRequestSchema,
  SettingsPatchSchema,
  UlidSchema,
  UpdateCollectionRequestSchema,
  UpdateEntryRequestSchema,
  entryStateLabel,
  parseCapture,
  type DateIntent,
  type Entry,
  type McpAddEntryInput,
  type McpAddToCollectionInput,
  type McpMigrationInput,
  type Settings,
} from './contracts/index.js';
import type { JournalConfig } from './config.js';
import type { ApiJournalOperations } from './api/routes.js';
import type {
  AgentActor,
  McpJournalOperations,
  MigrationInput,
  SearchInput,
} from './mcp/server.js';
import { DomainError } from './domain/errors.js';
import type { JournalDomain } from './domain/journal.js';
import type { ActorContext, SearchEntriesInput } from './domain/types.js';

interface DomainAdapters {
  api: ApiJournalOperations;
  mcp: McpJournalOperations;
}

function withCanonicalRequest<T extends { readonly id: string; readonly statusCode?: number }>(
  mutation: T,
  request: unknown,
): T & { readonly request: unknown } {
  return { ...mutation, request };
}

function mcpMutation(idempotencyKey: string | undefined, request: unknown) {
  return idempotencyKey === undefined
    ? undefined
    : { id: idempotencyKey, statusCode: 200, request };
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const instant = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function searchAll(
  domain: JournalDomain,
  input: Omit<SearchEntriesInput, 'limit' | 'offset'>,
): Entry[] {
  const entries: Entry[] = [];
  let before: EntryCursor | undefined;
  for (;;) {
    const page = domain.pageEntries({ ...input, limit: 100 }, before);
    entries.push(...page.items);
    if (!page.hasMore || page.items.length === 0) return entries;
    const last = page.items[page.items.length - 1]!;
    before = { date: last.date, createdAt: last.createdAt, id: last.id };
  }
}

function resolveDateIntent(intent: DateIntent): string {
  switch (intent.kind) {
    case 'absolute':
      return intent.date;
    case 'today':
      return intent.baseToday;
    case 'tomorrow':
      return addDays(intent.baseToday, 1);
  }
}

function agentEntry(entry: Entry) {
  return {
    id: entry.id,
    date: entry.date,
    type: entry.type,
    text: entry.text,
    state: entry.state,
    stateLabel: entryStateLabel(entry),
    time: entry.time,
    tags: [...entry.tags],
    author: entry.author,
    source: entry.source,
    migrations: entry.migrations,
    collection: entry.collection,
    revision: entry.revision,
    deletedAt: entry.deletedAt,
  };
}

function requireAgentActivity<T extends { activityId?: string }>(
  result: T,
): T & { activityId: string } {
  if (!result.activityId) {
    throw new DomainError('INTEGRITY_ERROR', 'Agent write committed without an activity record.');
  }
  return { ...result, activityId: result.activityId };
}

interface EntryCursor {
  readonly date: string;
  readonly createdAt: string;
  readonly id: string;
}

interface ActivityCursor {
  readonly at: string;
  readonly id?: string;
}

function encodeEntryCursor(entry: Entry): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      date: entry.date,
      createdAt: entry.createdAt,
      id: entry.id,
    }),
  ).toString('base64url');
}

function decodeEntryCursor(cursor: string | undefined): EntryCursor | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      version?: unknown;
      date?: unknown;
      createdAt?: unknown;
      id?: unknown;
    };
    if (decoded.version !== 1) throw new Error();
    return {
      date: CalendarDateSchema.parse(decoded.date),
      createdAt: IsoTimestampSchema.parse(decoded.createdAt),
      id: UlidSchema.parse(decoded.id),
    };
  } catch {
    throw new DomainError('VALIDATION_ERROR', 'Invalid entries cursor.');
  }
}

function encodeActivityCursor(activity: { readonly at: string; readonly id: string }): string {
  return Buffer.from(JSON.stringify({ version: 1, at: activity.at, id: activity.id })).toString(
    'base64url',
  );
}

function decodeActivityCursor(cursor: string | undefined): ActivityCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      version?: unknown;
      at?: unknown;
      id?: unknown;
    };
    if (decoded.version !== 1) throw new Error();
    return { at: IsoTimestampSchema.parse(decoded.at), id: UlidSchema.parse(decoded.id) };
  } catch {
    const legacy = IsoTimestampSchema.safeParse(cursor);
    if (legacy.success) return { at: legacy.data };
    throw new DomainError('VALIDATION_ERROR', 'Invalid activity cursor.');
  }
}

function calendar(date: string) {
  const instant = new Date(`${date}T12:00:00.000Z`);
  return {
    month: date.slice(0, 7),
    day: Number(date.slice(8, 10)),
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(instant),
  };
}

function uniqueEntries(groups: readonly (readonly Entry[])[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const group of groups) for (const entry of group) byId.set(entry.id, entry);
  return [...byId.values()].sort(
    (left, right) =>
      right.date.localeCompare(left.date) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
  );
}

function summaryOrLatest(domain: JournalDomain, id: string | undefined) {
  const summary = id === undefined ? domain.getLatestSummary() : domain.getSummary(id);
  if (!summary) {
    throw new DomainError(
      'NOT_FOUND',
      id === undefined ? 'No weekly summary exists yet.' : `Summary ${id} was not found.`,
    );
  }
  return summary;
}

function domainAgent(actor: AgentActor): Extract<ActorContext, { kind: 'agent' }> {
  return {
    kind: 'agent',
    tokenId: actor.tokenId,
    tokenLabel: actor.tokenLabel,
    ...(actor.tool === undefined ? {} : { tool: actor.tool }),
    ...(actor.tailscaleUserLogin === undefined
      ? {}
      : { tailscaleUserLogin: actor.tailscaleUserLogin }),
  };
}

export function createDomainAdapters(domain: JournalDomain, config: JournalConfig): DomainAdapters {
  const api: ApiJournalOperations = {
    pairDevice: (label) => domain.pairDevice(label),
    authenticateDevice: (secret) => domain.authenticateDevice(secret),

    bootstrap: (owner) => {
      const today = domain.today();
      const recent = searchAll(domain, { dateFrom: addDays(today, -13) });
      const openTasks = searchAll(domain, { type: 'task', state: 'open' });
      const monthly = searchAll(domain, { collection: `month:${today.slice(0, 7)}` });
      return {
        today,
        timezone: config.timezone,
        deviceId: owner.deviceId,
        entries: uniqueEntries([recent, openTasks, monthly]),
        collections: domain.listCollections(),
        latestSummary: domain.getLatestSummary(),
        activity: domain.listActivityViews(50),
        settings: domain.getSettings() as Settings,
      };
    },

    listEntries: (raw) => {
      const query = EntryQuerySchema.parse(raw);
      const cursor = decodeEntryCursor(query.cursor);
      const page = domain.pageEntries(
        {
          ...(query.q === undefined ? {} : { query: query.q }),
          ...(query.type === undefined ? {} : { type: query.type }),
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.author === undefined ? {} : { author: query.author }),
          ...(query.tag === undefined ? {} : { tag: query.tag }),
          ...(query.collection === undefined ? {} : { collection: query.collection }),
          ...(query.from === undefined ? {} : { dateFrom: query.from }),
          ...(query.to === undefined ? {} : { dateTo: query.to }),
          limit: query.limit,
        },
        cursor,
      );
      const items = page.items;
      return {
        today: domain.today(),
        timezone: config.timezone,
        items,
        nextCursor: page.hasMore ? encodeEntryCursor(items[items.length - 1]!) : null,
      };
    },

    createEntry: (raw, owner, mutation) => {
      const input = CreateEntryRequestSchema.parse(raw);
      const result = domain.createEntry(
        {
          id: input.id,
          text: input.text,
          type: input.type,
          date: resolveDateIntent(input.dateIntent),
          time: input.time,
          tags: input.tags,
          collection: input.collection,
        },
        owner,
        withCanonicalRequest(mutation, input),
      );
      if (result.kind !== 'entry')
        throw new DomainError('INTEGRITY_ERROR', 'Owner create produced a summary.');
      return { entry: result.entry };
    },

    updateEntry: (id, rawPatch, expectedRevision, owner, mutation) => {
      const body = UpdateEntryRequestSchema.parse({ patch: rawPatch, expectedRevision });
      const result = domain.updateEntry(
        id,
        body.patch,
        owner,
        withCanonicalRequest(mutation, { id, ...body }),
        {
          ...(body.expectedRevision === undefined
            ? {}
            : { expectedRevision: body.expectedRevision }),
        },
      );
      return { entry: result.entry };
    },

    deleteEntry: (id, expectedRevision, owner, mutation) => {
      const request = { id, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
      const result = domain.deleteEntry(id, owner, withCanonicalRequest(mutation, request), {
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      return { entry: result.entry };
    },

    capture: (raw, owner, mutation) => {
      const input = CaptureRequestSchema.parse(raw);
      const parsed = parseCapture(input.draft, input.defaultType);
      const result = domain.createEntry(
        {
          text: parsed.text,
          type: parsed.type,
          date: resolveDateIntent(input.dateIntent),
          time: parsed.time,
          tags: parsed.tags,
          collection: parsed.collection,
        },
        owner,
        withCanonicalRequest(mutation, input),
      );
      if (result.kind !== 'entry')
        throw new DomainError('INTEGRITY_ERROR', 'Capture produced a summary.');
      return { entry: result.entry, parsed };
    },

    migrateEntry: (id, raw, owner, mutation) => {
      const input = MigrateEntryRequestSchema.parse(raw);
      const result = domain.migrateEntry(
        id,
        {
          newEntryId: input.newEntryId,
          targetDate: input.target,
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: input.expectedRevision }),
        },
        owner,
        withCanonicalRequest(mutation, { id, ...input }),
      );
      return { original: result.original, copy: result.copy };
    },

    scheduleMonthly: (id, raw, owner, mutation) => {
      const input = ScheduleMonthlyRequestSchema.parse(raw);
      const result = domain.scheduleMonthly(
        id,
        {
          copyId: input.copyId,
          month: input.month,
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: input.expectedRevision }),
        },
        owner,
        withCanonicalRequest(mutation, { id, ...input }),
      );
      return { original: result.original, copy: result.copy };
    },

    restoreEntry: (id, expectedRevision, owner) => {
      const result = domain.restoreEntry(id, owner, undefined, {
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      return { entry: result.entry };
    },

    listCollections: () => ({
      items: domain.listCollections(),
      today: domain.today(),
      timezone: config.timezone,
    }),

    listTags: () => ({ items: domain.listTags() }),

    createCollection: (raw, owner, mutation) => {
      const input = CreateCollectionRequestSchema.parse(raw);
      return {
        collection: domain.createCollection(input, owner, withCanonicalRequest(mutation, input)),
      };
    },

    updateCollection: (id, raw, owner, mutation) => {
      const input = UpdateCollectionRequestSchema.parse(raw);
      const collection = domain.updateCollection(
        id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.archived === undefined ? {} : { archived: input.archived }),
        },
        owner,
        withCanonicalRequest(mutation, { id, ...input }),
      );
      return { collection };
    },

    listActivity: (query) => {
      const page = domain.listActivityPage(query.limit, decodeActivityCursor(query.before));
      return {
        items: page.items,
        nextCursor:
          page.hasMore && page.items.length > 0
            ? encodeActivityCursor(page.items[page.items.length - 1]!)
            : null,
      };
    },

    revertActivity: (id, owner) => {
      const result = domain.revertActivity(id, owner);
      return { activity: domain.activityView(result.activity), rows: result.reverted };
    },

    latestSummary: (owner, month) => {
      void owner;
      return { summary: domain.getLatestSummary(month) };
    },
    saveLatestSummary: (summaryId, expectedRevision, owner) => {
      const summary = summaryOrLatest(domain, summaryId);
      const result = domain.saveSummaryToToday(summary.id, owner, undefined, {
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      return { summary: result.summary, entry: result.entry };
    },
    rewriteLatestSummary: (summaryId, expectedRevision, owner) => {
      const result = domain.rewriteSummary(
        summaryOrLatest(domain, summaryId).id,
        owner,
        undefined,
        {
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        },
      );
      return { summary: result.summary };
    },

    getSettings: () => domain.getSettings(),
    updateSettings: (raw, owner) => {
      const input = SettingsPatchSchema.parse(raw);
      return domain.setSettings(
        {
          ...(input.density === undefined ? {} : { density: input.density }),
          ...(input.showTypeBadges === undefined ? {} : { showTypeBadges: input.showTypeBadges }),
          ...(input.highlightAiEntries === undefined
            ? {}
            : { highlightAiEntries: input.highlightAiEntries }),
        },
        owner,
      );
    },
    listTokens: () => ({ tokens: domain.listAgentTokens() }),
    createToken: (label, owner) => domain.createAgentToken(label, ['journal:full'], owner),
    revokeToken: (id, owner) => {
      domain.revokeAgentToken(id, owner);
      return { revoked: true, id };
    },
  };

  const mcp: McpJournalOperations = {
    authenticateToken: (secret) => domain.authenticateAgent(secret),
    consumeWriteRateLimit: (tokenId) => domain.consumeWriteRateLimit(tokenId),

    addEntry: (raw, agent, idempotencyKey) => {
      const input = raw as Omit<McpAddEntryInput, 'idempotencyKey'>;
      const result = requireAgentActivity(
        domain.createEntry(
          {
            text: input.text,
            type: input.type,
            ...(input.date === undefined ? {} : { date: input.date }),
            time: input.time ?? null,
            tags: input.tags,
            source: input.source,
            ...(input.summaryWeekStart === undefined
              ? {}
              : { summaryWeekStart: input.summaryWeekStart }),
          },
          domainAgent(agent),
          mcpMutation(idempotencyKey, input),
        ),
      );
      return result.kind === 'entry'
        ? { kind: 'entry', entry: agentEntry(result.entry), activityId: result.activityId }
        : { kind: 'summary', summary: result.summary, activityId: result.activityId };
    },

    addToCollection: (raw, agent, idempotencyKey) => {
      const input = raw as Omit<McpAddToCollectionInput, 'idempotencyKey'>;
      const result = requireAgentActivity(
        domain.createEntry(
          {
            text: input.text,
            type: input.type,
            tags: input.tags,
            collection: input.collection,
            source: input.source,
          },
          domainAgent(agent),
          mcpMutation(idempotencyKey, input),
        ),
      );
      if (result.kind !== 'entry')
        throw new DomainError('INTEGRITY_ERROR', 'Collection write produced a summary.');
      return { entry: agentEntry(result.entry), activityId: result.activityId };
    },

    listDay: (date) => {
      const result = domain.listDay(date);
      return {
        date: result.date,
        today: domain.today(),
        isToday: result.isToday,
        calendar: calendar(result.date),
        entries: result.entries.map(agentEntry),
        leftovers: {
          count: result.leftovers.count,
          entries: result.leftovers.entries.map(agentEntry),
        },
      };
    },

    search: (input: SearchInput) => {
      const result = domain.searchEntries(input);
      return { total: result.total, entries: result.entries.map(agentEntry) };
    },

    updateEntry: (id, patch, reason, expectedRevision, agent, idempotencyKey) => {
      const result = requireAgentActivity(
        domain.updateEntry(
          id,
          patch,
          domainAgent(agent),
          mcpMutation(idempotencyKey, { id, patch, reason, expectedRevision }),
          {
            reason,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          },
        ),
      );
      return { entry: agentEntry(result.entry), activityId: result.activityId };
    },

    deleteEntry: (id, reason, expectedRevision, agent, idempotencyKey) => {
      const result = requireAgentActivity(
        domain.deleteEntry(
          id,
          domainAgent(agent),
          mcpMutation(idempotencyKey, { id, reason, expectedRevision }),
          {
            reason,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          },
        ),
      );
      return { entry: agentEntry(result.entry), activityId: result.activityId };
    },

    applyMigration: (raw: MigrationInput, agent: AgentActor, idempotencyKey) => {
      const input = raw as Omit<McpMigrationInput, 'idempotencyKey'>;
      const result = domain.applyAgentMigration(
        input,
        domainAgent(agent),
        mcpMutation(idempotencyKey, input),
      );
      return { entries: result.entries.map(agentEntry), activityId: result.activityId };
    },

    index: () => {
      const countedCollections = domain
        .listCollections({ includeMonths: true })
        .map((collection) => ({
          ...collection,
          count: domain.searchEntries({ collection: collection.id, limit: 1 }).total,
        }));
      const collections = countedCollections.filter(
        (collection) => !collection.id.startsWith('month:'),
      );
      const months = countedCollections
        .filter((collection) => collection.id.startsWith('month:') && collection.count > 0)
        .sort((left, right) => right.id.localeCompare(left.id));
      const openTasks = domain.searchEntries({ type: 'task', state: 'open', limit: 1 }).total;
      const assistantEntries = domain.searchEntries({ author: 'ai', limit: 1 }).total;
      const workEntries = domain.searchEntries({ tag: 'work', limit: 1 }).total;
      return {
        collections,
        months,
        savedViews: [
          { id: 'open-tasks', count: openTasks },
          { id: 'assistant', count: assistantEntries },
          { id: 'work', count: workEntries },
        ],
      };
    },

    collection: (id) => {
      const collection = domain.getCollection(id);
      if (!collection) throw new DomainError('NOT_FOUND', `Collection ${id} was not found.`);
      const entries = searchAll(domain, { collection: id });
      return { collection, total: entries.length, entries: entries.map(agentEntry) };
    },

    latestSummary: () => {
      const summary = domain.getLatestSummary();
      return { summary, status: summary?.status ?? 'stale' };
    },
  };

  return { api, mcp };
}
