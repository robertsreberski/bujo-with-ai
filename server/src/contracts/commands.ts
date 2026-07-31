import { z } from 'zod';
import { EntryStateSchema, EntryTypeSchema } from './entities.js';
import {
  CalendarDateSchema,
  CalendarMonthSchema,
  CollectionIdSchema,
  EntryTextSchema,
  IsoTimestampSchema,
  LocalTimeSchema,
  McpSourceSchema,
  TagSchema,
  TagsSchema,
  TimeZoneSchema,
  UlidSchema,
} from './primitives.js';

const EntryCreateFields = {
  text: EntryTextSchema.describe('Single-line journal text.'),
  type: EntryTypeSchema.default('task').describe('Entry type; defaults to task.'),
  date: CalendarDateSchema.optional().describe('Daily journal date; server today by default.'),
  time: LocalTimeSchema.nullable().default(null).describe('Optional 24-hour display time.'),
  tags: TagsSchema.default([]).describe('Unique lowercase tags without #.'),
  collection: CollectionIdSchema.nullable()
    .default(null)
    .describe('Optional collection slug or month:YYYY-MM.'),
} as const;

/**
 * Safe, actor-neutral entry creation fields after a REST date intent or MCP
 * default has been resolved. Server-owned author/state/revision fields are
 * deliberately absent.
 */
export const EntryCreateSchema = z.strictObject(EntryCreateFields);

export const AgentEntryCreateSchema = z.strictObject({
  ...EntryCreateFields,
  source: McpSourceSchema.describe('Required human-readable provenance.'),
});

export const EntryPatchSchema = z
  .strictObject({
    text: EntryTextSchema.optional().describe('Replacement single-line journal text.'),
    type: EntryTypeSchema.optional().describe('Replacement entry type.'),
    date: CalendarDateSchema.optional().describe('Replacement daily journal date.'),
    time: LocalTimeSchema.nullable().optional().describe('Replacement time, or null to clear it.'),
    tags: TagsSchema.optional().describe('Complete replacement tag list.'),
    state: EntryStateSchema.optional().describe('Replacement lifecycle state.'),
    collection: CollectionIdSchema.nullable()
      .optional()
      .describe('Replacement collection, or null to remove the entry from a collection.'),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Patch must contain at least one field.');

export const ExpectedRevisionSchema = z
  .number()
  .int()
  .positive()
  .describe('Entry revision observed by the caller.');

const CaptureContextFields = {
  capturedAt: IsoTimestampSchema,
  baseToday: CalendarDateSchema,
  timezone: TimeZoneSchema,
} as const;

export const CaptureContextSchema = z.strictObject(CaptureContextFields);

export const DateIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('today'), ...CaptureContextFields }),
  z.strictObject({ kind: z.literal('tomorrow'), ...CaptureContextFields }),
  z.strictObject({
    kind: z.literal('absolute'),
    date: CalendarDateSchema,
    ...CaptureContextFields,
  }),
]);

/** Owner creation DTO. The server stamps every lifecycle and attribution field. */
export const OwnerEntryCreateSchema = z.strictObject({
  id: UlidSchema,
  text: EntryTextSchema,
  type: EntryTypeSchema.default('task'),
  time: LocalTimeSchema.nullable().default(null),
  tags: TagsSchema.default([]),
  collection: CollectionIdSchema.nullable().default(null),
  dateIntent: DateIntentSchema,
});

export const UpdateEntryCommandSchema = z.strictObject({
  patch: EntryPatchSchema,
  expectedRevision: ExpectedRevisionSchema.optional(),
});

export const MigrateEntryCommandSchema = z.strictObject({
  newEntryId: UlidSchema,
  target: CalendarDateSchema,
  expectedRevision: ExpectedRevisionSchema.optional(),
});

export const ScheduleMonthlyCommandSchema = z.strictObject({
  copyId: UlidSchema,
  month: CalendarMonthSchema,
  expectedRevision: ExpectedRevisionSchema.optional(),
});

export const MigrationKindSchema = z.enum(['split', 'drop', 'retag', 'move', 'other']);

const MigrationCreateOperationSchema = z.strictObject({
  op: z.literal('create').describe('Create a new AI-authored entry.'),
  entry: AgentEntryCreateSchema.describe('Complete entry to create.'),
});

const MigrationUpdateOperationSchema = z.strictObject({
  op: z.literal('update').describe('Update one existing entry.'),
  id: UlidSchema.describe('Entry id returned by list_day or search.'),
  expectedRevision: ExpectedRevisionSchema,
  patch: EntryPatchSchema.describe('Non-empty entry patch.'),
});

const MigrationDeleteOperationSchema = z.strictObject({
  op: z.literal('delete').describe('Soft-delete one existing entry.'),
  id: UlidSchema.describe('Entry id returned by list_day or search.'),
  expectedRevision: ExpectedRevisionSchema,
});

const MigrationRetagOperationSchema = z
  .strictObject({
    op: z.literal('retag').describe('Replace one tag across matching live entries.'),
    from: TagSchema.describe('Existing tag to replace.'),
    to: TagSchema.describe('Replacement tag.'),
  })
  .refine((operation) => operation.from !== operation.to, {
    path: ['to'],
    message: 'Retag source and target must differ.',
  });

export const MigrationOperationSchema = z.discriminatedUnion('op', [
  MigrationCreateOperationSchema,
  MigrationUpdateOperationSchema,
  MigrationDeleteOperationSchema,
  MigrationRetagOperationSchema,
]);

export const SearchInputSchema = z
  .strictObject({
    query: z.string().trim().max(500).optional().describe('Optional text or #tag query.'),
    type: EntryTypeSchema.optional().describe('Filter by entry type.'),
    state: EntryStateSchema.optional().describe('Filter by lifecycle state.'),
    author: z.enum(['me', 'ai']).optional().describe('Filter by original author.'),
    tag: TagSchema.optional().describe('Filter by one exact tag.'),
    collection: z
      .union([CollectionIdSchema, z.literal('daily')])
      .optional()
      .describe('Filter by a collection, or daily entries with no collection.'),
    dateFrom: CalendarDateSchema.optional().describe('Inclusive earliest journal date.'),
    dateTo: CalendarDateSchema.optional().describe('Inclusive latest journal date.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum results; defaults to 25.'),
  })
  .refine(
    (input) =>
      input.dateFrom === undefined || input.dateTo === undefined || input.dateFrom <= input.dateTo,
    { path: ['dateTo'], message: 'dateTo cannot precede dateFrom.' },
  );

export type EntryCreate = z.infer<typeof EntryCreateSchema>;
export type AgentEntryCreate = z.infer<typeof AgentEntryCreateSchema>;
export type EntryPatch = z.infer<typeof EntryPatchSchema>;
export type CaptureContext = z.infer<typeof CaptureContextSchema>;
export type DateIntent = z.infer<typeof DateIntentSchema>;
export type OwnerEntryCreate = z.infer<typeof OwnerEntryCreateSchema>;
export type UpdateEntryCommand = z.infer<typeof UpdateEntryCommandSchema>;
export type MigrateEntryCommand = z.infer<typeof MigrateEntryCommandSchema>;
export type ScheduleMonthlyCommand = z.infer<typeof ScheduleMonthlyCommandSchema>;
export type MigrationKind = z.infer<typeof MigrationKindSchema>;
export type MigrationOperation = z.infer<typeof MigrationOperationSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;
