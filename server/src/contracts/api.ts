import { z } from 'zod';
import {
  DateIntentSchema,
  ExpectedRevisionSchema,
  MigrateEntryCommandSchema,
  OwnerEntryCreateSchema,
  ScheduleMonthlyCommandSchema,
  SearchInputSchema,
  UpdateEntryCommandSchema,
} from './commands.js';
import {
  ActivityItemSchema,
  ActivitySnapshotSchema,
  ActivityViewSchema,
  AgentTokenScopesSchema,
  AgentTokenSchema,
  CollectionSchema,
  EntrySchema,
  EntryTypeSchema,
  SavedViewSchema,
  SavedViewsSchema,
  ReflectionSchema,
  SettingsSchema,
  SummarySchema,
} from './entities.js';
import {
  CalendarDateSchema,
  CalendarMonthSchema,
  CollectionIdSchema,
  CursorSchema,
  IdempotencyKeySchema,
  IsoTimestampSchema,
  MutationIdSchema,
  TagSchema,
  TimeZoneSchema,
  UlidSchema,
} from './primitives.js';
import { ParsedCaptureSchema } from '../domain/parser.js';

export const MutationIdHeaderSchema = MutationIdSchema.describe(
  'Required Idempotency-Key (or legacy X-Mutation-ID) request header.',
);

export const PairRequestSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(80).optional(),
  })
  .default({});

export const PairResponseSchema = z.strictObject({
  deviceId: UlidSchema,
  expiresAt: IsoTimestampSchema,
});

export const CreateEntryRequestSchema = OwnerEntryCreateSchema;
export const UpdateEntryRequestSchema = UpdateEntryCommandSchema;
export const DeleteEntryRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema.optional(),
});
export const RestoreEntryRequestSchema = DeleteEntryRequestSchema;
export const MigrateEntryRequestSchema = MigrateEntryCommandSchema;
export const ScheduleMonthlyRequestSchema = ScheduleMonthlyCommandSchema;

export const CaptureRequestSchema = z.strictObject({
  draft: z.string().max(2_000),
  defaultType: EntryTypeSchema.default('task'),
  dateIntent: DateIntentSchema,
});

/** Parsed query values; HTTP adapters remain responsible for coercing strings. */
export const EntryQuerySchema = z
  .strictObject({
    from: CalendarDateSchema.optional(),
    to: CalendarDateSchema.optional(),
    collection: z.union([CollectionIdSchema, z.literal('daily')]).optional(),
    state: SearchInputSchema.shape.state,
    type: SearchInputSchema.shape.type,
    author: SearchInputSchema.shape.author,
    tag: SearchInputSchema.shape.tag,
    q: z.string().trim().max(500).optional(),
    limit: z.number().int().min(1).max(100).default(100),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .refine((input) => input.from === undefined || input.to === undefined || input.from <= input.to, {
    path: ['to'],
    message: 'to cannot precede from.',
  });

/**
 * The chronological feed is deliberately narrower than general search. A
 * page may be anchored at a day and may continue from one opaque tuple cursor;
 * it cannot silently widen into an unbounded archive request.
 */
export const TimelineQuerySchema = z.strictObject({
  to: CalendarDateSchema.optional(),
  limit: z.number().int().min(1).max(100).default(100),
  cursor: z.string().trim().min(1).max(500).optional(),
});

export const CreateCollectionRequestSchema = z.strictObject({
  id: CollectionIdSchema,
  name: z.string().trim().min(1).max(120),
  note: z.string().trim().min(1).max(300).nullable().default(null),
});

export const UpdateCollectionRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().min(1).max(300).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Patch must contain at least one field.');

export const ActivityQuerySchema = z.strictObject({
  before: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe('Opaque activity cursor, or a legacy ISO timestamp.'),
  limit: z.number().int().min(1).max(100).default(50),
});

export const ReflectionQuerySchema = z
  .strictObject({
    from: CalendarDateSchema,
    to: CalendarDateSchema,
  })
  .refine((input) => input.from <= input.to, {
    path: ['to'],
    message: 'to cannot precede from.',
  });

export const ReflectionRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
});

export const ReflectionRestoreRequestSchema = ReflectionRequestSchema;

export const RevertActivityRequestSchema = z
  .strictObject({
    expectedActivityId: UlidSchema.optional(),
  })
  .default({});

export const SummarySaveRequestSchema = z
  .strictObject({
    summaryId: UlidSchema.optional().describe('Exact summary to save; latest when omitted.'),
    expectedRevision: ExpectedRevisionSchema.optional(),
  })
  .default({});

export const SummaryRewriteRequestSchema = z
  .strictObject({
    summaryId: UlidSchema.optional().describe('Exact summary to rewrite; latest when omitted.'),
    expectedRevision: ExpectedRevisionSchema.optional(),
  })
  .default({});

export const SettingsPatchSchema = z
  .strictObject({
    density: z.enum(['comfortable', 'compact']).optional(),
    showTypeBadges: z.boolean().optional(),
    highlightAiEntries: z.boolean().optional(),
    savedViews: SavedViewsSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Patch must contain at least one field.');

export const TokenCreateRequestSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  scopes: AgentTokenScopesSchema.default(['journal:full']),
});

export const TokenCreateResponseSchema = z.strictObject({
  token: AgentTokenSchema,
  secret: z.string().min(32),
});

export const TokenListResponseSchema = z.strictObject({
  tokens: z.array(AgentTokenSchema),
});

export const TokenRevokeResponseSchema = z.strictObject({
  revoked: z.literal(true),
  id: UlidSchema,
});

export const AssistantStatusSchema = z.strictObject({
  endpoint: z.string().url(),
  status: z.enum(['connected', 'ready', 'offline']),
  activeSessions: z.number().int().nonnegative(),
});

export const TimelinePageResponseSchema = z.strictObject({
  today: CalendarDateSchema,
  timezone: TimeZoneSchema,
  items: z.array(EntrySchema).max(100),
  /** Only destinations referenced by this page, including archived/month logs. */
  collections: z.array(CollectionSchema),
  nextCursor: z.string().min(1).nullable(),
  /** Extension slots owned by the later Activity and Reflection features. */
  latestAgentTouch: ActivityViewSchema.nullable().optional(),
  weeklyReflection: SummarySchema.nullable().optional(),
});

export const BootstrapResponseSchema = z.strictObject({
  today: CalendarDateSchema,
  timezone: TimeZoneSchema,
  deviceId: UlidSchema,
  cursor: CursorSchema,
  entries: z.array(EntrySchema),
  collections: z.array(CollectionSchema),
  latestSummary: SummarySchema.nullable(),
  activity: z.array(ActivityViewSchema),
  settings: SettingsSchema,
  /** Optional during the additive compatibility window. */
  timeline: TimelinePageResponseSchema.optional(),
});

export const EntryListResponseSchema = z.strictObject({
  today: CalendarDateSchema,
  timezone: TimeZoneSchema,
  items: z.array(EntrySchema),
  nextCursor: z.string().min(1).nullable(),
});

export const IndexCollectionSchema = CollectionSchema.extend({
  count: z.number().int().nonnegative(),
});

export const IndexMonthSchema = z.strictObject({
  month: CalendarMonthSchema,
  count: z.number().int().positive(),
});

export const IndexTypeSchema = z.strictObject({
  type: EntryTypeSchema,
  count: z.number().int().nonnegative(),
});

export const IndexSavedViewSchema = SavedViewSchema.extend({
  count: z.number().int().nonnegative(),
});

export const IndexResponseSchema = z.strictObject({
  collections: z.array(IndexCollectionSchema),
  months: z.array(IndexMonthSchema),
  types: z.array(IndexTypeSchema),
  savedViews: z.array(IndexSavedViewSchema),
});

export const EntryResponseSchema = z.strictObject({ entry: EntrySchema });

export const DeletedEntryDestinationSchema = z.strictObject({
  collectionId: CollectionIdSchema.nullable(),
  collectionName: z.string().trim().min(1).max(120).nullable(),
  status: z.enum(['daily', 'active', 'archived', 'missing']),
});

export const RecentlyDeletedEntrySchema = z.strictObject({
  entry: EntrySchema.refine((entry) => entry.deletedAt !== null, {
    message: 'Recently deleted entries require deletedAt.',
  }),
  expiresAt: IsoTimestampSchema,
  destination: DeletedEntryDestinationSchema,
});

export const RecentlyDeletedListResponseSchema = z.strictObject({
  items: z.array(RecentlyDeletedEntrySchema),
});

export const RestoreEntryResponseSchema = z.strictObject({
  entry: EntrySchema.refine((entry) => entry.deletedAt === null, {
    message: 'Restored entries cannot remain deleted.',
  }),
  destination: z.strictObject({
    outcome: z.enum(['original', 'daily_fallback']),
    originalCollectionId: CollectionIdSchema.nullable(),
  }),
});

export const MigratedEntryResponseSchema = z.strictObject({
  original: EntrySchema,
  copy: EntrySchema,
});

export const ScheduledEntryResponseSchema = z.strictObject({
  original: EntrySchema,
  copy: EntrySchema,
  collection: CollectionSchema.optional(),
});

export const CollectionResponseSchema = z.strictObject({ collection: CollectionSchema });

export const CaptureResponseSchema = z.strictObject({
  entry: EntrySchema,
  parsed: ParsedCaptureSchema,
});

export const ActivityListResponseSchema = z.strictObject({
  items: z.array(ActivityViewSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const CollectionListResponseSchema = z.strictObject({
  items: z.array(CollectionSchema),
  today: CalendarDateSchema,
  timezone: TimeZoneSchema,
});

export const TagUsageSchema = z.strictObject({
  tag: TagSchema,
  uses: z.number().int().positive(),
  lastUsedAt: IsoTimestampSchema,
});

export const TagListResponseSchema = z.strictObject({
  items: z.array(TagUsageSchema),
});

export const SettingsResponseSchema = z.strictObject({
  settings: SettingsSchema,
  assistant: AssistantStatusSchema,
});

export const RevertActivityResponseSchema = z.strictObject({
  activity: ActivityViewSchema,
  rows: z.array(ActivitySnapshotSchema),
});

export const LatestSummaryResponseSchema = z.strictObject({
  summary: SummarySchema.nullable(),
});

export const SaveSummaryResponseSchema = z.strictObject({
  summary: SummarySchema,
  entry: EntrySchema,
});

export const RewriteSummaryResponseSchema = z.strictObject({
  summary: SummarySchema,
});

export const ReflectionListResponseSchema = z.strictObject({
  items: z.array(ReflectionSchema),
});

export const ReflectionResponseSchema = z.strictObject({
  reflection: ReflectionSchema,
});

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export const ChangeOriginSchema = z.strictObject({
  kind: z.enum(['app', 'mcp', 'system']),
  deviceId: UlidSchema.optional(),
  tokenId: UlidSchema.optional(),
  tokenLabel: z.string().trim().min(1).max(80).optional(),
  tool: z.string().trim().min(1).max(80).optional(),
});

export const ChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('entry.created'), payload: EntrySchema }),
  z.strictObject({ kind: z.literal('entry.updated'), payload: EntrySchema }),
  z.strictObject({ kind: z.literal('entry.deleted'), payload: EntrySchema }),
  z.strictObject({ kind: z.literal('activity.appended'), payload: ActivityItemSchema }),
  z.strictObject({
    kind: z.literal('summary.changed'),
    payload: z.union([SummarySchema, z.strictObject({ id: UlidSchema })]),
  }),
  z.strictObject({
    kind: z.literal('reflection.changed'),
    payload: z.union([
      ReflectionSchema,
      z.strictObject({ id: UlidSchema, weekStart: CalendarDateSchema }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('collection.changed'),
    payload: z.union([CollectionSchema, z.strictObject({ id: CollectionIdSchema })]),
  }),
  z.strictObject({ kind: z.literal('settings.changed'), payload: SettingsSchema }),
  z.strictObject({ kind: z.literal('token.changed'), payload: AgentTokenSchema }),
]);

export const ChangeBatchSchema = z.strictObject({
  transactionId: UlidSchema,
  mutationId: z.union([MutationIdSchema, IdempotencyKeySchema]).nullable(),
  origin: ChangeOriginSchema,
  changes: z.array(ChangeSchema).min(1),
});

export const SseResetSchema = z.strictObject({
  reason: z.enum(['cursor_evicted', 'server_restarted']),
  currentCursor: CursorSchema,
});

export const SseReplayReadySchema = z.strictObject({
  cursor: CursorSchema,
});

const JournalExportDataObjectSchema = z.strictObject({
  entries: z.array(EntrySchema),
  collections: z.array(CollectionSchema),
  activity: z.array(ActivityItemSchema),
  summaries: z.array(SummarySchema),
  settings: SettingsSchema,
});

type JournalExportData = z.infer<typeof JournalExportDataObjectSchema>;
type JournalExportRefinementContext = Parameters<
  Parameters<typeof JournalExportDataObjectSchema.superRefine>[0]
>[1];

function refineJournalExportData(
  journal: JournalExportData,
  context: JournalExportRefinementContext,
): void {
  const requireUnique = (
    values: readonly string[],
    path: 'entries' | 'collections' | 'activity' | 'summaries',
    label: string,
  ): void => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: 'custom',
          path: [path, index, label],
          message: `Duplicate ${label} in journal export.`,
        });
      }
      seen.add(value);
    });
  };
  requireUnique(
    journal.entries.map((entry) => entry.id),
    'entries',
    'id',
  );
  requireUnique(
    journal.collections.map((collection) => collection.id),
    'collections',
    'id',
  );
  requireUnique(
    journal.activity.map((activity) => activity.id),
    'activity',
    'id',
  );
  requireUnique(
    journal.summaries.map((summary) => summary.id),
    'summaries',
    'id',
  );
  requireUnique(
    journal.summaries.map((summary) => summary.weekStart),
    'summaries',
    'weekStart',
  );
  const collectionIds = new Set(journal.collections.map((collection) => collection.id));
  journal.collections.forEach((collection, index) => {
    if (collection.id.startsWith('month:') && collection.archivedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['collections', index, 'archivedAt'],
        message: 'Month collections cannot be archived.',
      });
    }
  });
  const entriesById = new Map(journal.entries.map((entry) => [entry.id, entry]));
  journal.entries.forEach((entry, index) => {
    if (entry.collection !== null && !collectionIds.has(entry.collection)) {
      context.addIssue({
        code: 'custom',
        path: ['entries', index, 'collection'],
        message: `Entry references missing collection ${entry.collection}.`,
      });
    }
  });
  journal.summaries.forEach((summary, index) => {
    if (summary.savedEntryId === null) return;
    const entry = entriesById.get(summary.savedEntryId);
    if (
      entry === undefined ||
      entry.deletedAt !== null ||
      entry.author !== 'ai' ||
      entry.type !== 'note' ||
      !entry.tags.includes('summary')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['summaries', index, 'savedEntryId'],
        message: 'Saved summary must reference a live AI-authored summary note.',
      });
    }
  });
}

const JournalExportDataSchema = JournalExportDataObjectSchema.superRefine(refineJournalExportData);

const ReflectionExportProjectionSchema = z
  .strictObject({
    version: z.literal(1),
    items: z.array(ReflectionSchema),
  })
  .superRefine((projection, context) => {
    const slotIds = new Set<string>();
    const weekStarts = new Set<string>();
    const versionIds = new Set<string>();
    projection.items.forEach((reflection, reflectionIndex) => {
      if (slotIds.has(reflection.id)) {
        context.addIssue({
          code: 'custom',
          path: ['items', reflectionIndex, 'id'],
          message: 'Reflection ids must be unique across the projection.',
        });
      }
      slotIds.add(reflection.id);
      if (weekStarts.has(reflection.weekStart)) {
        context.addIssue({
          code: 'custom',
          path: ['items', reflectionIndex, 'weekStart'],
          message: 'Reflection weeks must be unique across the projection.',
        });
      }
      weekStarts.add(reflection.weekStart);
      reflection.versions.forEach((version, versionIndex) => {
        if (versionIds.has(version.id)) {
          context.addIssue({
            code: 'custom',
            path: ['items', reflectionIndex, 'versions', versionIndex, 'id'],
            message: 'Reflection version ids must be unique across the projection.',
          });
        }
        versionIds.add(version.id);
      });
    });
  });

export const SummaryReflectionRevertSchema = z
  .strictObject({
    activityId: UlidSchema,
    reflectionId: UlidSchema,
    legacySummaryId: UlidSchema.nullable(),
    before: ReflectionSchema.nullable(),
    after: ReflectionSchema,
  })
  .superRefine((provenance, context) => {
    if (
      provenance.legacySummaryId !== null &&
      provenance.legacySummaryId !== provenance.reflectionId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['legacySummaryId'],
        message: 'Legacy Summary provenance must identify the recorded Reflection.',
      });
    }
  });

const SummaryReflectionRevertProjectionSchema = z
  .strictObject({
    version: z.literal(1),
    items: z.array(SummaryReflectionRevertSchema),
  })
  .superRefine((projection, context) => {
    const activityIds = new Set<string>();
    projection.items.forEach((item, index) => {
      if (activityIds.has(item.activityId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'activityId'],
          message: 'Summary Reflection revert activity ids must be unique.',
        });
      }
      activityIds.add(item.activityId);
      if (
        item.after.id !== item.reflectionId ||
        (item.before !== null && item.before.id !== item.reflectionId)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'reflectionId'],
          message: 'Summary Reflection revert states must belong to the recorded Reflection.',
        });
      }
    });
  });

const JournalDerivedSchema = z
  .object({
    /** Added after v2 shipped; absence means an older portable document. */
    reflections: ReflectionExportProjectionSchema.optional(),
    summaryReflectionReverts: SummaryReflectionRevertProjectionSchema.optional(),
  })
  .catchall(z.unknown());

/** Historical flat export accepted indefinitely for restore portability. */
export const JournalExportV1Schema = z
  .strictObject({
    version: z.literal(1),
    exportedAt: IsoTimestampSchema,
    ...JournalExportDataObjectSchema.shape,
  })
  .superRefine((journal, context) => {
    refineJournalExportData(journal, context);
  });

/**
 * Current export envelope. Derived projections are deliberately opaque to this
 * compatibility runtime: future releases may preserve them while old runtimes
 * safely import only the canonical journal payload.
 */
export const JournalExportV2Schema = z.strictObject({
  version: z.literal(2),
  exportedAt: IsoTimestampSchema,
  journal: JournalExportDataSchema,
  derived: JournalDerivedSchema.optional(),
});

/** Import contract spanning every portable Journal export format. */
export const JournalExportSchema = z.union([JournalExportV1Schema, JournalExportV2Schema]);

const ImportEntityCountsSchema = z.strictObject({
  entries: z.number().int().nonnegative(),
  collections: z.number().int().nonnegative(),
  activity: z.number().int().nonnegative(),
  summaries: z.number().int().nonnegative(),
  reflections: z.number().int().nonnegative(),
  summaryReflectionReverts: z.number().int().nonnegative(),
  settings: z.number().int().min(0).max(1),
});

export const ImportReportSchema = z.strictObject({
  inserted: ImportEntityCountsSchema,
  skipped: ImportEntityCountsSchema,
});

export type PairRequest = z.infer<typeof PairRequestSchema>;
export type PairResponse = z.infer<typeof PairResponseSchema>;
export type CreateEntryRequest = z.infer<typeof CreateEntryRequestSchema>;
export type UpdateEntryRequest = z.infer<typeof UpdateEntryRequestSchema>;
export type DeleteEntryRequest = z.infer<typeof DeleteEntryRequestSchema>;
export type MigrateEntryRequest = z.infer<typeof MigrateEntryRequestSchema>;
export type ScheduleMonthlyRequest = z.infer<typeof ScheduleMonthlyRequestSchema>;
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;
export type EntryQuery = z.infer<typeof EntryQuerySchema>;
export type TimelineQuery = z.infer<typeof TimelineQuerySchema>;
export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequestSchema>;
export type UpdateCollectionRequest = z.infer<typeof UpdateCollectionRequestSchema>;
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;
export type ReflectionQuery = z.infer<typeof ReflectionQuerySchema>;
export type ReflectionListResponse = z.infer<typeof ReflectionListResponseSchema>;
export type ReflectionResponse = z.infer<typeof ReflectionResponseSchema>;
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
export type TimelinePageResponse = z.infer<typeof TimelinePageResponseSchema>;
export type EntryListResponse = z.infer<typeof EntryListResponseSchema>;
export type RecentlyDeletedEntry = z.infer<typeof RecentlyDeletedEntrySchema>;
export type RecentlyDeletedListResponse = z.infer<typeof RecentlyDeletedListResponseSchema>;
export type RestoreEntryResponse = z.infer<typeof RestoreEntryResponseSchema>;
export type IndexResponse = z.infer<typeof IndexResponseSchema>;
export type CollectionListResponse = z.infer<typeof CollectionListResponseSchema>;
export type TagUsage = z.infer<typeof TagUsageSchema>;
export type TagListResponse = z.infer<typeof TagListResponseSchema>;
export type ActivityListResponse = z.infer<typeof ActivityListResponseSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type ChangeOrigin = z.infer<typeof ChangeOriginSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type ChangeBatch = z.infer<typeof ChangeBatchSchema>;
export type JournalExport = z.infer<typeof JournalExportSchema>;
export type JournalExportV1 = z.infer<typeof JournalExportV1Schema>;
export type JournalExportV2 = z.infer<typeof JournalExportV2Schema>;
export type SummaryReflectionRevert = z.infer<typeof SummaryReflectionRevertSchema>;
export type ImportReport = z.infer<typeof ImportReportSchema>;
