import { z } from 'zod';
import {
  CalendarDateSchema,
  CollectionIdSchema,
  EntryTextSchema,
  IsoTimestampSchema,
  LocalTimeSchema,
  SourceSchema,
  SummaryTextSchema,
  TagsSchema,
  UlidSchema,
  WeekStartSchema,
} from './primitives.js';

export const EntryTypeSchema = z
  .enum(['task', 'event', 'note', 'idea', 'question', 'habit', 'mood'])
  .describe('Bullet-journal entry type.');

export const EntryStateSchema = z
  .enum(['open', 'done', 'logged', 'migrated', 'scheduled', 'cancelled'])
  .describe('Current entry lifecycle state.');

export const EntryAuthorSchema = z
  .enum(['me', 'ai'])
  .describe('Original author of the entry text.');

export const ActionableEntryStateSchema = z.enum([
  'open',
  'done',
  'migrated',
  'scheduled',
  'cancelled',
]);

export const EntrySchema = z
  .strictObject({
    id: UlidSchema,
    date: CalendarDateSchema,
    type: EntryTypeSchema,
    text: EntryTextSchema,
    state: EntryStateSchema,
    time: LocalTimeSchema.nullable(),
    tags: TagsSchema,
    author: EntryAuthorSchema,
    source: SourceSchema.nullable(),
    migrations: z.number().int().nonnegative(),
    collection: CollectionIdSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    revision: z.number().int().positive(),
    deletedAt: IsoTimestampSchema.nullable(),
  })
  .superRefine((entry, context) => {
    const actionable = isActionableEntryType(entry.type);
    if (actionable && entry.state === 'logged') {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: `${entry.type} entries cannot use the logged state.`,
      });
    }
    if (!actionable && entry.state !== 'logged') {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: `${entry.type} entries must use the logged state.`,
      });
    }
    if (entry.author === 'ai' && entry.source === null) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'AI-authored entries require human-readable provenance.',
      });
    }
    if (Date.parse(entry.updatedAt) < Date.parse(entry.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt.',
      });
    }
    if (entry.deletedAt !== null && Date.parse(entry.deletedAt) < Date.parse(entry.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['deletedAt'],
        message: 'deletedAt cannot precede createdAt.',
      });
    }
  });

export const CollectionSchema = z.strictObject({
  id: CollectionIdSchema,
  name: z.string().trim().min(1).max(120),
  note: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((value) => !/[\r\n]/.test(value), 'Collection notes must be one line.')
    .nullable(),
  createdAt: IsoTimestampSchema,
  archivedAt: IsoTimestampSchema.nullable(),
});

export const SummaryStatusSchema = z.enum(['current', 'stale', 'saved']);

export const SummarySchema = z
  .strictObject({
    id: UlidSchema,
    weekStart: WeekStartSchema,
    text: SummaryTextSchema,
    status: SummaryStatusSchema,
    source: SourceSchema,
    tokenId: UlidSchema,
    savedEntryId: UlidSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    revision: z.number().int().positive(),
  })
  .superRefine((summary, context) => {
    if (Date.parse(summary.updatedAt) < Date.parse(summary.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt.',
      });
    }
    if ((summary.status === 'saved') !== (summary.savedEntryId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['savedEntryId'],
        message: 'Only a saved summary may reference its saved entry.',
      });
    }
  });

const EntryActivitySnapshotSchema = z.strictObject({
  entity: z.literal('entry'),
  id: UlidSchema,
  row: EntrySchema.nullable(),
});

const SummaryActivitySnapshotSchema = z.strictObject({
  entity: z.literal('summary'),
  id: UlidSchema,
  row: SummarySchema.nullable(),
});

const CollectionActivitySnapshotSchema = z.strictObject({
  entity: z.literal('collection'),
  id: CollectionIdSchema,
  row: CollectionSchema.nullable(),
});

export const ActivitySnapshotSchema = z
  .discriminatedUnion('entity', [
    EntryActivitySnapshotSchema,
    SummaryActivitySnapshotSchema,
    CollectionActivitySnapshotSchema,
  ])
  .superRefine((snapshot, context) => {
    if (snapshot.row !== null && snapshot.row.id !== snapshot.id) {
      context.addIssue({
        code: 'custom',
        path: ['row', 'id'],
        message: 'Snapshot id must match the row id.',
      });
    }
  });

export const ActivityKindSchema = z.enum([
  'agent-add',
  'agent-update',
  'agent-delete',
  'agent-migration',
  'summary-filed',
  'summary-saved',
  'revert',
]);

export const ActivityOriginSchema = z.strictObject({
  actor: z.enum(['mcp', 'app', 'system']),
  tokenId: UlidSchema.optional(),
  deviceId: UlidSchema.optional(),
  tool: z.string().trim().min(1).max(80).optional(),
  tailscaleUserLogin: z.string().trim().min(1).max(320).optional(),
});

export const ActivityRefsSchema = z.strictObject({
  entryIds: z.array(UlidSchema),
  summaryId: UlidSchema.optional(),
  activityId: UlidSchema.optional(),
});

export const ActivityItemSchema = z
  .strictObject({
    id: UlidSchema,
    at: IsoTimestampSchema,
    text: z.string().trim().min(1).max(500),
    kind: ActivityKindSchema,
    origin: ActivityOriginSchema,
    refs: ActivityRefsSchema,
    preImages: z.array(ActivitySnapshotSchema),
    postImages: z.array(ActivitySnapshotSchema),
    revertedAt: IsoTimestampSchema.nullable(),
    revertedByActivityId: UlidSchema.nullable(),
  })
  .superRefine((activity, context) => {
    if ((activity.revertedAt === null) !== (activity.revertedByActivityId === null)) {
      context.addIssue({
        code: 'custom',
        path: ['revertedByActivityId'],
        message: 'Revert timestamp and linked activity id must be set together.',
      });
    }
    if (activity.preImages.length !== activity.postImages.length) {
      context.addIssue({
        code: 'custom',
        path: ['postImages'],
        message: 'Pre- and post-image arrays must be aligned.',
      });
      return;
    }
    for (const [index, before] of activity.preImages.entries()) {
      const after = activity.postImages[index];
      if (after === undefined || before.entity !== after.entity || before.id !== after.id) {
        context.addIssue({
          code: 'custom',
          path: ['postImages', index],
          message: 'Each post-image must identify the same row as its pre-image.',
        });
      }
    }
  });

export const ActivityRevertStatusSchema = z
  .strictObject({
    eligible: z.boolean(),
    reason: z.enum(['already_reverted', 'post_image_mismatch', 'not_reversible']).nullable(),
  })
  .refine((status) => status.eligible === (status.reason === null), {
    path: ['reason'],
    message: 'An eligible activity has no blocking reason; an ineligible one must explain why.',
  });

export const ActivityViewSchema = ActivityItemSchema.safeExtend({
  revert: ActivityRevertStatusSchema,
});

/** Compatibility alias for domain code; ActivityItem is the persisted entity name. */
export const ActivitySchema = ActivityItemSchema;

export const DensitySchema = z.enum(['comfortable', 'compact']);

export const SavedViewSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Saved view ids use letters, numbers, _ or -.'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((value) => !/[\r\n]/u.test(value), 'Saved view names must be one line.'),
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((value) => !/[\r\n]/u.test(value), 'Saved view queries must be one line.'),
});

export const SavedViewsSchema = z
  .array(SavedViewSchema)
  .max(50)
  .superRefine((views, context) => {
    const ids = new Set<string>();
    for (const [index, view] of views.entries()) {
      if (ids.has(view.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Saved view ids must be unique.',
        });
      }
      ids.add(view.id);
    }
  });

export const SettingsSchema = z.strictObject({
  density: DensitySchema,
  showTypeBadges: z.boolean(),
  highlightAiEntries: z.boolean(),
  /** Optional only at the compatibility boundary; current settings always persist an array. */
  savedViews: SavedViewsSchema.optional(),
  updatedAt: IsoTimestampSchema,
});

export const AgentTokenScopeSchema = z.enum([
  'journal:full',
  'timeline:read',
  'entry:write',
  'destructive',
  'preview:write',
]);

export const AgentTokenScopesSchema = z
  .array(AgentTokenScopeSchema)
  .min(1)
  .max(5)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({ code: 'custom', message: 'Agent token scopes must be unique.' });
    }
    if (scopes.includes('journal:full') && scopes.length > 1) {
      context.addIssue({
        code: 'custom',
        message: 'journal:full cannot be combined with narrower scopes.',
      });
    }
  });

export const AgentTokenSchema = z.strictObject({
  id: UlidSchema,
  label: z.string().trim().min(1).max(80),
  scopes: AgentTokenScopesSchema,
  createdAt: IsoTimestampSchema,
  lastUsedAt: IsoTimestampSchema.nullable(),
  revokedAt: IsoTimestampSchema.nullable(),
});

export const DeviceTokenSchema = z.strictObject({
  id: UlidSchema,
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  lastUsedAt: IsoTimestampSchema.nullable(),
});

export function isActionableEntryType(type: EntryType): type is 'task' | 'habit' {
  return type === 'task' || type === 'habit';
}

export function initialEntryState(type: EntryType): 'open' | 'logged' {
  return isActionableEntryType(type) ? 'open' : 'logged';
}

export function entryStateLabel(entry: Pick<Entry, 'state' | 'migrations'>): string | null {
  switch (entry.state) {
    case 'migrated':
      return 'Moved forward';
    case 'scheduled':
      return 'In monthly log';
    case 'cancelled':
      return 'Dropped';
    default:
      return entry.migrations > 1 ? `Moved ${entry.migrations}×` : null;
  }
}

export type EntryType = z.infer<typeof EntryTypeSchema>;
export type EntryState = z.infer<typeof EntryStateSchema>;
export type EntryAuthor = z.infer<typeof EntryAuthorSchema>;
export type Entry = z.infer<typeof EntrySchema>;
export type Collection = z.infer<typeof CollectionSchema>;
export type SummaryStatus = z.infer<typeof SummaryStatusSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;
export type ActivityKind = z.infer<typeof ActivityKindSchema>;
export type ActivityOrigin = z.infer<typeof ActivityOriginSchema>;
export type ActivityItem = z.infer<typeof ActivityItemSchema>;
export type Activity = ActivityItem;
export type ActivityView = z.infer<typeof ActivityViewSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type SavedView = z.infer<typeof SavedViewSchema>;
export type AgentToken = z.infer<typeof AgentTokenSchema>;
export type AgentTokenScope = z.infer<typeof AgentTokenScopeSchema>;
export type DeviceToken = z.infer<typeof DeviceTokenSchema>;
