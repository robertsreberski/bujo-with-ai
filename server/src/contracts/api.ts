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
  AgentTokenSchema,
  CollectionSchema,
  EntrySchema,
  EntryTypeSchema,
  SettingsSchema,
  SummarySchema,
} from './entities.js';
import {
  CalendarDateSchema,
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
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Patch must contain at least one field.');

export const TokenCreateRequestSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
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
});

export const EntryListResponseSchema = z.strictObject({
  today: CalendarDateSchema,
  timezone: TimeZoneSchema,
  items: z.array(EntrySchema),
  nextCursor: z.string().min(1).nullable(),
});

export const EntryResponseSchema = z.strictObject({ entry: EntrySchema });

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

export const JournalExportSchema = z
  .strictObject({
    version: z.literal(1),
    exportedAt: IsoTimestampSchema,
    entries: z.array(EntrySchema),
    collections: z.array(CollectionSchema),
    activity: z.array(ActivityItemSchema),
    summaries: z.array(SummarySchema),
    settings: SettingsSchema,
  })
  .superRefine((journal, context) => {
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
  });

const ImportEntityCountsSchema = z.strictObject({
  entries: z.number().int().nonnegative(),
  collections: z.number().int().nonnegative(),
  activity: z.number().int().nonnegative(),
  summaries: z.number().int().nonnegative(),
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
export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequestSchema>;
export type UpdateCollectionRequest = z.infer<typeof UpdateCollectionRequestSchema>;
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
export type EntryListResponse = z.infer<typeof EntryListResponseSchema>;
export type CollectionListResponse = z.infer<typeof CollectionListResponseSchema>;
export type TagUsage = z.infer<typeof TagUsageSchema>;
export type TagListResponse = z.infer<typeof TagListResponseSchema>;
export type ActivityListResponse = z.infer<typeof ActivityListResponseSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type ChangeOrigin = z.infer<typeof ChangeOriginSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type ChangeBatch = z.infer<typeof ChangeBatchSchema>;
export type JournalExport = z.infer<typeof JournalExportSchema>;
export type ImportReport = z.infer<typeof ImportReportSchema>;
