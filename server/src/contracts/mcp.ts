import { z } from 'zod';
import {
  EntryPatchSchema,
  ExpectedRevisionSchema,
  MigrationKindSchema,
  MigrationOperationSchema,
  SearchInputSchema,
} from './commands.js';
import {
  EntryAuthorSchema,
  EntryStateSchema,
  EntryTypeSchema,
  ReflectionSchema,
  SummarySchema,
  entryStateLabel,
  isActionableEntryType,
} from './entities.js';
import {
  CalendarDateSchema,
  CalendarMonthSchema,
  CollectionIdSchema,
  EntryTextSchema,
  IdempotencyKeySchema,
  IsoTimestampSchema,
  LocalTimeSchema,
  McpSourceSchema,
  SourceSchema,
  TagsSchema,
  UlidSchema,
  WeekStartSchema,
} from './primitives.js';

export const McpToolNameSchema = z.enum([
  'add_entry',
  'add_to_collection',
  'list_day',
  'search',
  'update_entry',
  'delete_entry',
  'propose_migration',
]);

export const McpToolModeSchema = z.enum(['automatic', 'read only']);

export const McpToolPermissionSchema = z.strictObject({
  name: McpToolNameSchema,
  mode: McpToolModeSchema,
});

export const AgentEntrySchema = z
  .strictObject({
    id: UlidSchema,
    date: CalendarDateSchema,
    type: EntryTypeSchema,
    text: EntryTextSchema,
    state: EntryStateSchema,
    stateLabel: z.string().nullable(),
    time: LocalTimeSchema.nullable(),
    tags: TagsSchema,
    author: EntryAuthorSchema,
    source: SourceSchema.nullable(),
    migrations: z.number().int().nonnegative(),
    collection: CollectionIdSchema.nullable(),
    revision: z.number().int().positive(),
    deletedAt: IsoTimestampSchema.nullable(),
  })
  .superRefine((entry, context) => {
    const actionable = isActionableEntryType(entry.type);
    if ((actionable && entry.state === 'logged') || (!actionable && entry.state !== 'logged')) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Entry type and state are incompatible.',
      });
    }
    if (entry.author === 'ai' && entry.source === null) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'AI-authored entries require provenance.',
      });
    }
    if (entry.stateLabel !== entryStateLabel(entry)) {
      context.addIssue({
        code: 'custom',
        path: ['stateLabel'],
        message: 'stateLabel does not match the entry state.',
      });
    }
  });

const OptionalIdempotencyField = {
  idempotencyKey: IdempotencyKeySchema.optional().describe(
    'Optional retry key. Reuse only with byte-equivalent canonical input.',
  ),
} as const;

export const McpAddEntryInputSchema = z
  .strictObject({
    text: EntryTextSchema.describe('Single-line journal text.'),
    type: EntryTypeSchema.default('note').describe('Entry type; defaults to note.'),
    date: CalendarDateSchema.optional().describe('Daily date; server today by default.'),
    time: LocalTimeSchema.optional().describe('Optional 24-hour display time.'),
    tags: TagsSchema.default([]).describe('Unique lowercase tags without #.'),
    source: McpSourceSchema.describe('Required human-readable provenance.'),
    summaryWeekStart: WeekStartSchema.optional().describe(
      'Explicit Monday week start when filing a weekly Summary.',
    ),
    reflectionAction: z
      .enum(['claim', 'complete', 'fail'])
      .optional()
      .describe('Lifecycle phase for a durable weekly Reflection request.'),
    reflectionRequestId: UlidSchema.optional().describe(
      'Request id returned by the Reflection card. Required for claim, complete, and fail.',
    ),
    ...OptionalIdempotencyField,
  })
  .superRefine((input, context) => {
    if (
      input.summaryWeekStart !== undefined &&
      (input.type !== 'note' || !input.tags.includes('summary'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['summaryWeekStart'],
        message: 'Summary filing requires type note and the summary tag.',
      });
    }
    if ((input.reflectionAction === undefined) !== (input.reflectionRequestId === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['reflectionRequestId'],
        message: 'Reflection lifecycle actions require a reflectionRequestId.',
      });
    }
    if (input.reflectionAction !== undefined && input.summaryWeekStart === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['summaryWeekStart'],
        message: 'Reflection lifecycle actions require the requested Monday week start.',
      });
    }
    if (
      input.summaryWeekStart !== undefined &&
      (input.date !== undefined || input.time !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['summaryWeekStart'],
        message: 'Summary filing cannot also specify a daily date or time.',
      });
    }
  });

export const McpAddEntryOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('entry'),
    entry: AgentEntrySchema,
    activityId: UlidSchema,
  }),
  z.strictObject({
    kind: z.literal('summary'),
    summary: SummarySchema,
    activityId: UlidSchema,
  }),
  z.strictObject({
    kind: z.literal('reflection'),
    reflection: ReflectionSchema,
    activityId: UlidSchema,
  }),
]);

export const McpAddToCollectionInputSchema = z
  .strictObject({
    collection: CollectionIdSchema.describe('Collection slug or month:YYYY-MM.'),
    text: EntryTextSchema.describe('Single-line journal text.'),
    type: EntryTypeSchema.default('task').describe('Entry type; defaults to task.'),
    date: CalendarDateSchema.optional().describe('Entry date; server today by default.'),
    time: LocalTimeSchema.optional().describe('Optional 24-hour display time.'),
    tags: TagsSchema.default([]).describe('Unique lowercase tags without #.'),
    source: McpSourceSchema.describe('Required human-readable provenance.'),
    ...OptionalIdempotencyField,
  })
  .superRefine((input, context) => {
    // A month log addresses its own month; a stated date that lands outside it
    // contradicts the collection. An omitted date still falls back to today,
    // which is how the app files into a month it is merely browsing.
    const month = /^month:(\d{4}-\d{2})$/.exec(input.collection)?.[1];
    if (input.date !== undefined && month !== undefined && !input.date.startsWith(`${month}-`)) {
      context.addIssue({
        code: 'custom',
        path: ['date'],
        message: `Date must fall within ${month} to belong to this month log.`,
      });
    }
  });

export const McpEntryWriteOutputSchema = z.strictObject({
  entry: AgentEntrySchema,
  activityId: UlidSchema,
});

export const McpListDayInputSchema = z.strictObject({
  date: CalendarDateSchema.optional().describe('Date to list; server today by default.'),
});

export const McpCalendarPositionSchema = z.strictObject({
  month: CalendarMonthSchema,
  day: z.number().int().min(1).max(31),
  weekday: z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']),
});

export const McpListDayOutputSchema = z.strictObject({
  date: CalendarDateSchema,
  today: CalendarDateSchema,
  isToday: z.boolean(),
  calendar: McpCalendarPositionSchema,
  entries: z.array(AgentEntrySchema),
  leftovers: z.strictObject({
    count: z.number().int().nonnegative(),
    entries: z.array(AgentEntrySchema),
  }),
});

export const McpSearchInputSchema = SearchInputSchema;

export const McpSearchOutputSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  entries: z.array(AgentEntrySchema),
});

const ReasonSchema = z
  .string()
  .trim()
  .min(5)
  .max(300)
  .refine((value) => !/[\r\n]/.test(value), 'Reason must be a single line.')
  .describe('Human-readable reason recorded in Activity.');

export const McpUpdateEntryInputSchema = z.strictObject({
  id: UlidSchema.describe('Entry id returned by list_day or search.'),
  patch: EntryPatchSchema.describe('Non-empty entry patch.'),
  reason: ReasonSchema,
  expectedRevision: ExpectedRevisionSchema.describe(
    'Required observed revision; a mismatch prevents the write.',
  ),
  ...OptionalIdempotencyField,
});

export const McpDeleteEntryInputSchema = z.strictObject({
  id: UlidSchema.describe('Entry id returned by list_day or search.'),
  reason: ReasonSchema,
  expectedRevision: ExpectedRevisionSchema.describe(
    'Required observed revision; a mismatch prevents the write.',
  ),
  ...OptionalIdempotencyField,
});

export const McpMigrationInputSchema = z.strictObject({
  kind: MigrationKindSchema.describe('BuJo hygiene classification.'),
  title: z.string().trim().min(5).max(120).describe('Short human audit title.'),
  detail: ReasonSchema.describe('Human rationale recorded in Activity.'),
  ops: z.array(MigrationOperationSchema).min(1).max(10).describe('Atomic ordered operations.'),
  lines: z
    .array(z.string().trim().min(1).max(500))
    .max(6)
    .default([])
    .describe('Optional plain-text audit details.'),
  ...OptionalIdempotencyField,
});

export const McpMigrationOutputSchema = z.strictObject({
  status: z.literal('applied'),
  message: z.literal('Applied migration'),
  entries: z.array(AgentEntrySchema),
  activityId: UlidSchema,
});

export const McpCompatibleProposalsResourceSchema = z.strictObject({
  mode: z.literal('automatic'),
  proposals: z.tuple([]),
});

// Concise aliases for tool registration code.
export const AddEntryInputSchema = McpAddEntryInputSchema;
export const AddEntryOutputSchema = McpAddEntryOutputSchema;
export const AddToCollectionInputSchema = McpAddToCollectionInputSchema;
export const AddToCollectionOutputSchema = McpEntryWriteOutputSchema;
export const ListDayInputSchema = McpListDayInputSchema;
export const ListDayOutputSchema = McpListDayOutputSchema;
export const SearchToolInputSchema = McpSearchInputSchema;
export const SearchOutputSchema = McpSearchOutputSchema;
export const UpdateEntryInputSchema = McpUpdateEntryInputSchema;
export const UpdateEntryOutputSchema = McpEntryWriteOutputSchema;
export const DeleteEntryInputSchema = McpDeleteEntryInputSchema;
export const DeleteEntryOutputSchema = McpEntryWriteOutputSchema;
export const ProposeMigrationInputSchema = McpMigrationInputSchema;
export const ProposeMigrationOutputSchema = McpMigrationOutputSchema;

export type McpToolName = z.infer<typeof McpToolNameSchema>;
export type AgentEntry = z.infer<typeof AgentEntrySchema>;
export type McpAddEntryInput = z.infer<typeof McpAddEntryInputSchema>;
export type McpAddEntryOutput = z.infer<typeof McpAddEntryOutputSchema>;
export type McpAddToCollectionInput = z.infer<typeof McpAddToCollectionInputSchema>;
export type McpEntryWriteOutput = z.infer<typeof McpEntryWriteOutputSchema>;
export type McpListDayInput = z.infer<typeof McpListDayInputSchema>;
export type McpListDayOutput = z.infer<typeof McpListDayOutputSchema>;
export type McpSearchInput = z.infer<typeof McpSearchInputSchema>;
export type McpSearchOutput = z.infer<typeof McpSearchOutputSchema>;
export type McpUpdateEntryInput = z.infer<typeof McpUpdateEntryInputSchema>;
export type McpDeleteEntryInput = z.infer<typeof McpDeleteEntryInputSchema>;
export type McpMigrationInput = z.infer<typeof McpMigrationInputSchema>;
export type McpMigrationOutput = z.infer<typeof McpMigrationOutputSchema>;
