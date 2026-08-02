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

function addUtcCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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
    dateStated: z
      .boolean()
      .describe('True when the day on this entry was chosen rather than defaulted.'),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    revision: z.number().int().positive(),
    deletedAt: IsoTimestampSchema.nullable(),
  })
  .superRefine((entry, context) => {
    const actionable = isActionableEntryType(entry.type);
    // A daily-log entry's day is the log it sits in, so it is always stated.
    // Only a filing can be undated: "sometime this month" has no day to name.
    if (entry.collection === null && !entry.dateStated) {
      context.addIssue({
        code: 'custom',
        path: ['dateStated'],
        message: 'A daily-log entry always states its day.',
      });
    }
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

export const ReflectionStatusSchema = z.enum([
  'notRequested',
  'queued',
  'running',
  'current',
  'stale',
  'failed',
]);

export const ReflectionGeneratorSchema = z.strictObject({
  tokenId: UlidSchema,
  label: z.string().trim().min(1).max(80),
  tool: z.string().trim().min(1).max(80).optional(),
  source: SourceSchema,
});

export const ReflectionSourceEntrySchema = z.strictObject({
  id: UlidSchema,
  revision: z.number().int().positive(),
});

export const ReflectionVersionSchema = z.strictObject({
  id: UlidSchema,
  number: z.number().int().positive(),
  text: SummaryTextSchema,
  sourceFrom: CalendarDateSchema,
  sourceTo: CalendarDateSchema,
  generator: ReflectionGeneratorSchema,
  generatedAt: IsoTimestampSchema,
  sourceEntries: z.array(ReflectionSourceEntrySchema),
});

export const ReflectionSchema = z
  .strictObject({
    id: UlidSchema,
    weekStart: WeekStartSchema,
    weekEnd: CalendarDateSchema,
    status: ReflectionStatusSchema,
    revision: z.number().int().positive(),
    requestId: UlidSchema.nullable(),
    requestedAt: IsoTimestampSchema.nullable(),
    claimedAt: IsoTimestampSchema.nullable(),
    claimedBy: ReflectionGeneratorSchema.omit({ source: true }).nullable(),
    /** Source revisions pinned by the active claim. Optional for older clients. */
    claimedSourceEntries: z.array(ReflectionSourceEntrySchema).nullable().optional(),
    failure: z.string().trim().min(1).max(500).nullable(),
    currentVersionId: UlidSchema.nullable(),
    currentVersion: ReflectionVersionSchema.nullable(),
    versions: z.array(ReflectionVersionSchema),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .superRefine((reflection, context) => {
    if (reflection.weekEnd !== addUtcCalendarDays(reflection.weekStart, 6)) {
      context.addIssue({
        code: 'custom',
        path: ['weekEnd'],
        message: 'weekEnd must be exactly six days after weekStart.',
      });
    }
    if (Date.parse(reflection.updatedAt) < Date.parse(reflection.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt.',
      });
    }
    const requested = reflection.requestId !== null && reflection.requestedAt !== null;
    if (['queued', 'running', 'failed'].includes(reflection.status) !== requested) {
      context.addIssue({
        code: 'custom',
        path: ['requestId'],
        message: 'Queued, running, and failed reflections require a durable request.',
      });
    }
    if ((reflection.status === 'running') !== (reflection.claimedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['claimedAt'],
        message: 'Only a running reflection may have an active claim.',
      });
    }
    if ((reflection.status === 'running') !== (reflection.claimedBy !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['claimedBy'],
        message: 'Only a running reflection may identify its claimant.',
      });
    }
    if (
      reflection.claimedSourceEntries !== undefined &&
      (reflection.status === 'running') !== (reflection.claimedSourceEntries !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['claimedSourceEntries'],
        message: 'Only a running reflection may retain claimed source revisions.',
      });
    }
    const claimedSourceIds = new Set<string>();
    for (const [index, sourceEntry] of (reflection.claimedSourceEntries ?? []).entries()) {
      if (claimedSourceIds.has(sourceEntry.id)) {
        context.addIssue({
          code: 'custom',
          path: ['claimedSourceEntries', index, 'id'],
          message: 'Claimed source entry ids must be unique.',
        });
      }
      claimedSourceIds.add(sourceEntry.id);
    }
    const versionIds = new Set<string>();
    const versionNumbers = new Set<number>();
    reflection.versions.forEach((version, index) => {
      if (versionIds.has(version.id)) {
        context.addIssue({
          code: 'custom',
          path: ['versions', index, 'id'],
          message: 'Reflection version ids must be unique.',
        });
      }
      versionIds.add(version.id);
      if (versionNumbers.has(version.number)) {
        context.addIssue({
          code: 'custom',
          path: ['versions', index, 'number'],
          message: 'Reflection version numbers must be unique.',
        });
      }
      versionNumbers.add(version.number);
      if (version.sourceFrom !== reflection.weekStart || version.sourceTo !== reflection.weekEnd) {
        context.addIssue({
          code: 'custom',
          path: ['versions', index, 'sourceFrom'],
          message: 'Reflection versions must use their Reflection week range.',
        });
      }
      const sourceIds = new Set<string>();
      version.sourceEntries.forEach((sourceEntry, sourceIndex) => {
        if (sourceIds.has(sourceEntry.id)) {
          context.addIssue({
            code: 'custom',
            path: ['versions', index, 'sourceEntries', sourceIndex, 'id'],
            message: 'Reflection version source entry ids must be unique.',
          });
        }
        sourceIds.add(sourceEntry.id);
      });
    });
    if ((reflection.status === 'failed') !== (reflection.failure !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Only a failed reflection may include a failure reason.',
      });
    }
    const hasCurrentId = reflection.currentVersionId !== null;
    const hasCurrentVersion = reflection.currentVersion !== null;
    if (hasCurrentId !== hasCurrentVersion) {
      context.addIssue({
        code: 'custom',
        path: ['currentVersion'],
        message: 'currentVersionId and currentVersion must both be null or both be selected.',
      });
    }
    const hasCurrent = hasCurrentId && hasCurrentVersion;
    if (['current', 'stale'].includes(reflection.status) && !hasCurrent) {
      context.addIssue({
        code: 'custom',
        path: ['currentVersion'],
        message: 'Current and stale reflections require a selected version.',
      });
    }
    if (
      reflection.currentVersion !== null &&
      reflection.currentVersion.id !== reflection.currentVersionId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['currentVersionId'],
        message: 'currentVersionId must identify currentVersion.',
      });
    }
    if (
      reflection.currentVersionId !== null &&
      !reflection.versions.some((version) => version.id === reflection.currentVersionId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['versions'],
        message: 'The selected reflection version must be retained in version history.',
      });
    }
    if (reflection.currentVersion !== null) {
      const selected = reflection.versions.find(
        (version) => version.id === reflection.currentVersionId,
      );
      if (
        selected !== undefined &&
        JSON.stringify(selected) !== JSON.stringify(reflection.currentVersion)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['currentVersion'],
          message: 'currentVersion must equal the selected retained version.',
        });
      }
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
  tokenLabel: z.string().trim().min(1).max(80).optional(),
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

/** Human-readable audit semantics derived from the immutable activity record. */
export const ActivityActorSummarySchema = z.strictObject({
  kind: z.enum(['owner', 'agent', 'system']),
  label: z.string().trim().min(1).max(120),
  tokenId: UlidSchema.optional(),
  tool: z.string().trim().min(1).max(80).optional(),
});

export const ActivityActionSchema = z.enum([
  'added',
  'updated',
  'deleted',
  'migrated',
  'scheduled',
  'filed-summary',
  'saved-summary',
  'reverted',
]);

export const ActivityEntryAttributionSchema = z.strictObject({
  entryId: UlidSchema,
  originalAuthor: z.enum(['owner', 'agent', 'unknown']),
  latestModifier: ActivityActorSummarySchema.nullable(),
});

export const ActivityLineageSchema = z.strictObject({
  fromEntryIds: z.array(UlidSchema),
  toEntryIds: z.array(UlidSchema),
  relatedActivityId: UlidSchema.nullable(),
});

/**
 * Deliberately compact: Timeline may surface this value without inheriting the
 * audit screen's snapshots, migration graph, or revert controls.
 */
export const AgentTouchSchema = z.strictObject({
  activityId: UlidSchema,
  entryId: UlidSchema,
  at: IsoTimestampSchema,
  actor: ActivityActorSummarySchema,
  action: ActivityActionSchema,
  reason: z.string().trim().min(1).max(500).nullable(),
});

export const ActivityPresentationSchema = z.strictObject({
  actor: ActivityActorSummarySchema,
  action: ActivityActionSchema,
  objectLabel: z.string().trim().min(1).max(160),
  primaryEntryId: UlidSchema.nullable(),
  reason: z.string().trim().min(1).max(500).nullable(),
  attribution: z.array(ActivityEntryAttributionSchema),
  lineage: ActivityLineageSchema.nullable(),
  latestAgentTouch: AgentTouchSchema.nullable(),
});

export const ActivityViewSchema = ActivityItemSchema.safeExtend({
  revert: ActivityRevertStatusSchema,
  // Optional only for compatibility with activity.appended stream records
  // produced by older servers. HTTP activity pages always populate it.
  presentation: ActivityPresentationSchema.optional(),
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
export type ReflectionStatus = z.infer<typeof ReflectionStatusSchema>;
export type ReflectionGenerator = z.infer<typeof ReflectionGeneratorSchema>;
export type ReflectionSourceEntry = z.infer<typeof ReflectionSourceEntrySchema>;
export type ReflectionVersion = z.infer<typeof ReflectionVersionSchema>;
export type Reflection = z.infer<typeof ReflectionSchema>;
export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;
export type ActivityKind = z.infer<typeof ActivityKindSchema>;
export type ActivityOrigin = z.infer<typeof ActivityOriginSchema>;
export type ActivityItem = z.infer<typeof ActivityItemSchema>;
export type Activity = ActivityItem;
export type ActivityActorSummary = z.infer<typeof ActivityActorSummarySchema>;
export type ActivityAction = z.infer<typeof ActivityActionSchema>;
export type ActivityEntryAttribution = z.infer<typeof ActivityEntryAttributionSchema>;
export type ActivityLineage = z.infer<typeof ActivityLineageSchema>;
export type AgentTouch = z.infer<typeof AgentTouchSchema>;
export type ActivityPresentation = z.infer<typeof ActivityPresentationSchema>;
export type ActivityView = z.infer<typeof ActivityViewSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type SavedView = z.infer<typeof SavedViewSchema>;
export type AgentToken = z.infer<typeof AgentTokenSchema>;
export type AgentTokenScope = z.infer<typeof AgentTokenScopeSchema>;
export type DeviceToken = z.infer<typeof DeviceTokenSchema>;
