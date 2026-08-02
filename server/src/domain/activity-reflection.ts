import type Database from 'better-sqlite3';
import { ActivityItemSchema, ActivityViewSchema, IsoTimestampSchema } from '../contracts/index.js';
import { DomainError } from './errors.js';
import {
  activityChange,
  activityContentExpired,
  actorRefs,
  addCalendarDays,
  invalid,
  isMonday,
  mapActivity,
  mapCollection,
  mapEntry,
  mapReflection,
  mapSummary,
  mondayOf,
  normalizeSource,
  normalizeText,
  reflectionChange,
  snapshotEqual,
  stableJson,
  truncateForActivity,
  upsertChange,
  validateDate,
  validateId,
  type ActivityAuditInput,
  type ActivityRow,
  type CollectionRow,
  type EntryRow,
  type JournalWritePort,
  type ReflectionSlotRow,
  type ReflectionVersionRow,
  type SummaryRow,
  type WriteContext,
} from './kernel.js';
import type {
  ActivityAction,
  ActivityActorSummary,
  ActivityItem,
  ActivityKind,
  ActivityLineage,
  ActivityPresentation,
  ActivityView,
  ActorContext,
  Entry,
  MutationContext,
  Reflection,
  ReflectionVersion,
  Snapshot,
  Summary,
} from './types.js';

export interface ActivityPageBoundary {
  readonly at: string;
  readonly id?: string;
}

export interface ActivityPage {
  readonly items: readonly ActivityView[];
  readonly hasMore: boolean;
}

export interface ActivityReflectionOptions {
  readonly db: Database.Database;
  readonly today: () => string;
  readonly now: () => Date;
  readonly idFactory: () => string;
  readonly write: JournalWritePort;
}

/** Activity audit/read models and the weekly Reflection lifecycle. */
export class ActivityReflection {
  private readonly db: Database.Database;
  private readonly today: () => string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly write: JournalWritePort;

  public constructor(options: ActivityReflectionOptions) {
    this.db = options.db;
    this.today = options.today;
    this.now = options.now;
    this.idFactory = options.idFactory;
    this.write = options.write;
  }

  public listActivity(limit = 100, offset = 0): readonly ActivityItem[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      invalid('limit must be between 1 and 500');
    if (!Number.isInteger(offset) || offset < 0) invalid('offset must be a non-negative integer');
    return (
      this.db
        .prepare('SELECT * FROM activity ORDER BY at DESC, id DESC LIMIT ? OFFSET ?')
        .all(limit, offset) as ActivityRow[]
    ).map(mapActivity);
  }

  public getActivity(id: string): ActivityItem | null {
    validateId(id);
    const row = this.db.prepare('SELECT * FROM activity WHERE id = ?').get(id) as
      | ActivityRow
      | undefined;
    return row === undefined ? null : mapActivity(row);
  }

  public activityView(activityOrId: ActivityItem | string): ActivityView {
    const activity =
      typeof activityOrId === 'string' ? this.getActivity(activityOrId) : activityOrId;
    if (activity === null)
      throw new DomainError('NOT_FOUND', `Activity ${activityOrId} was not found`);
    return this.activityViews([activity])[0]!;
  }

  public listActivityViews(limit = 100, offset = 0): readonly ActivityView[] {
    return this.activityViews(this.listActivity(limit, offset));
  }

  public listActivityPage(limit = 50, before?: ActivityPageBoundary): ActivityPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      invalid('limit must be between 1 and 100');
    if (before !== undefined) {
      if (!IsoTimestampSchema.safeParse(before.at).success) invalid('Invalid activity cursor time');
      if (before.id !== undefined) validateId(before.id);
    }
    const rows = (
      before === undefined
        ? this.db.prepare('SELECT * FROM activity ORDER BY at DESC, id DESC LIMIT ?').all(limit + 1)
        : before.id === undefined
          ? this.db
              .prepare('SELECT * FROM activity WHERE at <= ? ORDER BY at DESC, id DESC LIMIT ?')
              .all(before.at, limit + 1)
          : this.db
              .prepare(
                `SELECT * FROM activity WHERE at < ? OR (at = ? AND id < ?)
                 ORDER BY at DESC, id DESC LIMIT ?`,
              )
              .all(before.at, before.at, before.id, limit + 1)
    ) as ActivityRow[];
    return {
      items: this.activityViews(rows.slice(0, limit).map(mapActivity)),
      hasMore: rows.length > limit,
    };
  }

  public listReflections(from: string, to: string): readonly Reflection[] {
    validateDate(from);
    validateDate(to);
    if (from > to) invalid('Reflection range end cannot precede its start');
    this.materializeReflectionSlots(from, to);
    const rows = this.db
      .prepare(
        `SELECT * FROM reflection_slots
         WHERE week_start <= ? AND week_end >= ? AND week_end < ?
         ORDER BY week_start DESC`,
      )
      .all(to, from, this.today()) as ReflectionSlotRow[];
    return rows.map((row) => this.mapReflectionRow(row));
  }

  public getReflection(id: string): Reflection | null {
    validateId(id);
    const row = this.db.prepare('SELECT * FROM reflection_slots WHERE id = ?').get(id) as
      | ReflectionSlotRow
      | undefined;
    return row === undefined ? null : this.mapReflectionRow(row);
  }

  public listPendingReflections(): readonly Reflection[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reflection_slots
         WHERE status IN ('queued', 'running')
         ORDER BY requested_at ASC, week_start ASC`,
      )
      .all() as ReflectionSlotRow[];
    return rows.map((row) => this.mapReflectionRow(row));
  }

  public requestReflection(
    id: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
  ): { readonly reflection: Reflection; readonly activityId: string } {
    return this.queueReflection('request-reflection', id, actor, options, [
      'notRequested',
      'current',
      'stale',
    ]);
  }

  public retryReflection(
    id: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
  ): { readonly reflection: Reflection; readonly activityId: string } {
    return this.queueReflection('retry-reflection', id, actor, options, ['failed']);
  }

  public claimReflection(
    weekStart: string,
    requestId: string,
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly kind: 'reflection'; readonly reflection: Reflection; readonly activityId: string } {
    if (actor.kind !== 'agent') invalid('Only an authenticated assistant can claim a Reflection');
    validateDate(weekStart);
    validateId(requestId);
    return this.write.execute(
      'claim-reflection',
      { weekStart, requestId },
      actor,
      mutation,
      (context) => {
        const before = this.requireReflectionForWeek(weekStart);
        if (before.status !== 'queued' || before.requestId !== requestId) {
          throw new DomainError('CONFLICT', 'Reflection request is no longer queued');
        }
        this.db
          .prepare(
            `UPDATE reflection_slots SET
              status='running', claimed_at=?, claimed_token_id=?, claimed_label=?, claimed_tool=?,
              failure=NULL, updated_at=?, revision=revision+1
             WHERE id=?`,
          )
          .run(
            context.now,
            actor.tokenId,
            actor.tokenLabel,
            actor.tool ?? null,
            context.now,
            before.id,
          );
        const reflection = this.requireReflection(before.id);
        context.changes.push(reflectionChange(reflection));
        const activity = this.append(
          {
            kind: 'summary-filed',
            text: `Claimed weekly Reflection for ${weekStart}`,
            refs: { ...actorRefs(actor, []), summaryId: reflection.id },
            preImages: [],
            postImages: [],
          },
          actor,
          context,
        );
        return { kind: 'reflection', reflection, activityId: activity.id };
      },
    );
  }

  public completeReflection(
    input: {
      readonly weekStart: string;
      readonly requestId: string;
      readonly text: string;
      readonly source: string;
    },
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly kind: 'reflection'; readonly reflection: Reflection; readonly activityId: string } {
    if (actor.kind !== 'agent')
      invalid('Only an authenticated assistant can complete a Reflection');
    validateDate(input.weekStart);
    validateId(input.requestId);
    const text = normalizeText(input.text, 500, 'reflection text');
    const source = normalizeSource(input.source);
    return this.write.execute('complete-reflection', input, actor, mutation, (context) => {
      const before = this.requireReflectionForWeek(input.weekStart);
      if (
        before.status !== 'running' ||
        before.requestId !== input.requestId ||
        before.claimedBy?.tokenId !== actor.tokenId
      ) {
        throw new DomainError('CONFLICT', 'Reflection request is not claimed by this assistant');
      }
      const sourceEntries = this.reflectionSourceEntries(before.weekStart, before.weekEnd);
      const versionId = this.idFactory();
      const versionNumber = (before.versions[0]?.number ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO reflection_versions(
            id,reflection_id,version_number,text,source_from,source_to,generator_token_id,
            generator_label,generator_tool,source,generated_at,source_entries
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          versionId,
          before.id,
          versionNumber,
          text,
          before.weekStart,
          before.weekEnd,
          actor.tokenId,
          actor.tokenLabel,
          actor.tool ?? null,
          source,
          context.now,
          JSON.stringify(sourceEntries),
        );
      this.db
        .prepare(
          `UPDATE reflection_slots SET
            status='current', request_id=NULL, requested_at=NULL, claimed_at=NULL,
            claimed_token_id=NULL, claimed_label=NULL, claimed_tool=NULL, failure=NULL,
            current_version_id=?, updated_at=?, revision=revision+1
           WHERE id=?`,
        )
        .run(versionId, context.now, before.id);
      const reflection = this.requireReflection(before.id);
      context.changes.push(reflectionChange(reflection));
      const activity = this.append(
        {
          kind: 'summary-filed',
          text: `Completed weekly Reflection for ${before.weekStart}`,
          refs: {
            ...actorRefs(
              actor,
              sourceEntries.map((entry) => entry.id),
            ),
            summaryId: before.id,
          },
          preImages: [],
          postImages: [],
        },
        actor,
        context,
      );
      return { kind: 'reflection', reflection, activityId: activity.id };
    });
  }

  public failReflection(
    input: { readonly weekStart: string; readonly requestId: string; readonly reason: string },
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly kind: 'reflection'; readonly reflection: Reflection; readonly activityId: string } {
    if (actor.kind !== 'agent') invalid('Only an authenticated assistant can fail a Reflection');
    validateDate(input.weekStart);
    validateId(input.requestId);
    const reason = normalizeText(input.reason, 500, 'reflection failure');
    return this.write.execute('fail-reflection', input, actor, mutation, (context) => {
      const before = this.requireReflectionForWeek(input.weekStart);
      if (
        before.status !== 'running' ||
        before.requestId !== input.requestId ||
        before.claimedBy?.tokenId !== actor.tokenId
      ) {
        throw new DomainError('CONFLICT', 'Reflection request is not claimed by this assistant');
      }
      this.db
        .prepare(
          `UPDATE reflection_slots SET
            status='failed', claimed_at=NULL, claimed_token_id=NULL, claimed_label=NULL,
            claimed_tool=NULL, failure=?, updated_at=?, revision=revision+1
           WHERE id=?`,
        )
        .run(reason, context.now, before.id);
      const reflection = this.requireReflection(before.id);
      context.changes.push(reflectionChange(reflection));
      const activity = this.append(
        {
          kind: 'summary-filed',
          text: `Weekly Reflection failed for ${before.weekStart}: ${truncateForActivity(reason)}`,
          refs: { ...actorRefs(actor, []), summaryId: before.id },
          preImages: [],
          postImages: [],
        },
        actor,
        context,
      );
      return { kind: 'reflection', reflection, activityId: activity.id };
    });
  }

  public restoreReflectionVersion(
    id: string,
    versionId: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
  ): { readonly reflection: Reflection; readonly activityId: string } {
    validateId(id);
    validateId(versionId);
    return this.write.execute(
      'restore-reflection-version',
      { id, versionId, expectedRevision: options.expectedRevision },
      actor,
      undefined,
      (context) => {
        const before = this.requireReflection(id);
        this.assertExpectedReflectionRevision(before, options.expectedRevision);
        const version = before.versions.find((candidate) => candidate.id === versionId);
        if (!version) throw new DomainError('NOT_FOUND', 'Reflection version was not found');
        const current = this.reflectionVersionIsCurrent(version);
        this.db
          .prepare(
            `UPDATE reflection_slots SET
              status=?, request_id=NULL, requested_at=NULL, claimed_at=NULL,
              claimed_token_id=NULL, claimed_label=NULL, claimed_tool=NULL, failure=NULL,
              current_version_id=?, updated_at=?, revision=revision+1
             WHERE id=?`,
          )
          .run(current ? 'current' : 'stale', version.id, context.now, before.id);
        const reflection = this.requireReflection(id);
        context.changes.push(reflectionChange(reflection));
        const activity = this.append(
          {
            kind: 'summary-filed',
            text: `Restored Reflection version ${version.number} for ${before.weekStart}`,
            refs: {
              ...actorRefs(
                actor,
                version.sourceEntries.map((entry) => entry.id),
              ),
              summaryId: before.id,
            },
            preImages: [],
            postImages: [],
          },
          actor,
          context,
        );
        return { reflection, activityId: activity.id };
      },
    );
  }

  /** Runs from Journal's transaction runner before SQLite commits the command. */
  public beforeCommit(context: WriteContext): void {
    if (!context.changes.some((change) => change.kind.startsWith('entry.'))) return;
    const rows = this.db
      .prepare("SELECT * FROM reflection_slots WHERE status = 'current'")
      .all() as ReflectionSlotRow[];
    for (const row of rows) {
      const current = this.requireReflection(row.id);
      if (
        current.currentVersion !== null &&
        this.reflectionVersionIsCurrent(current.currentVersion)
      ) {
        continue;
      }
      this.db
        .prepare(
          `UPDATE reflection_slots
           SET status='stale', updated_at=?, revision=revision+1
           WHERE id=?`,
        )
        .run(context.now, row.id);
      const reflection = this.requireReflection(row.id);
      context.changes.push(reflectionChange(reflection));
      const summary = this.getSummaryForWeek(row.week_start);
      if (summary?.status === 'current') {
        const stale: Summary = {
          ...summary,
          status: 'stale',
          updatedAt: context.now,
          revision: summary.revision + 1,
        };
        this.updateSummaryRow(stale);
        context.changes.push(upsertChange('summary', stale));
      }
    }
  }

  public upsertLegacyReflection(
    summary: Summary,
    actor: Extract<ActorContext, { readonly kind: 'agent' }>,
    context: WriteContext,
  ): Reflection {
    const existingRow = this.db
      .prepare('SELECT * FROM reflection_slots WHERE week_start = ?')
      .get(summary.weekStart) as ReflectionSlotRow | undefined;
    const weekEnd = addCalendarDays(summary.weekStart, 6);
    const reflectionId = existingRow?.id ?? summary.id;
    if (existingRow === undefined) {
      this.db
        .prepare(
          `INSERT INTO reflection_slots(
            id,week_start,week_end,status,request_id,requested_at,claimed_at,claimed_token_id,
            claimed_label,claimed_tool,failure,current_version_id,created_at,updated_at,revision
           ) VALUES (?, ?, ?, 'notRequested', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 1)`,
        )
        .run(reflectionId, summary.weekStart, weekEnd, context.now, context.now);
    }
    const versionNumber =
      (this.db
        .prepare(
          'SELECT coalesce(max(version_number), 0) FROM reflection_versions WHERE reflection_id = ?',
        )
        .pluck()
        .get(reflectionId) as number) + 1;
    const versionId = this.idFactory();
    this.db
      .prepare(
        `INSERT INTO reflection_versions(
          id,reflection_id,version_number,text,source_from,source_to,generator_token_id,
          generator_label,generator_tool,source,generated_at,source_entries
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        versionId,
        reflectionId,
        versionNumber,
        summary.text,
        summary.weekStart,
        weekEnd,
        actor.tokenId,
        actor.tokenLabel,
        actor.tool ?? null,
        summary.source,
        context.now,
        JSON.stringify(this.reflectionSourceEntries(summary.weekStart, weekEnd)),
      );
    this.db
      .prepare(
        `UPDATE reflection_slots SET
          status='current', request_id=NULL, requested_at=NULL, claimed_at=NULL,
          claimed_token_id=NULL, claimed_label=NULL, claimed_tool=NULL, failure=NULL,
          current_version_id=?, updated_at=?, revision=revision+1
         WHERE id=?`,
      )
      .run(versionId, context.now, reflectionId);
    return this.requireReflection(reflectionId);
  }

  public append(
    input: ActivityAuditInput,
    actor: ActorContext,
    context: WriteContext,
  ): ActivityItem {
    const activity = ActivityItemSchema.parse({
      id: input.id ?? this.idFactory(),
      at: context.now,
      kind: input.kind,
      text: normalizeText(input.text, 500, 'activity text'),
      origin: activityOrigin(actor),
      refs: input.refs,
      preImages: [...input.preImages, ...context.implicitSnapshots.map((snapshot) => snapshot.pre)],
      postImages: [
        ...input.postImages,
        ...context.implicitSnapshots.map((snapshot) => snapshot.post),
      ],
      revertedAt: null,
      revertedByActivityId: null,
    });
    this.db
      .prepare(
        `INSERT INTO activity(
          id,at,kind,text,origin,refs,pre_images,post_images,reverted_at,reverted_by_activity_id
        ) VALUES (@id,@at,@kind,@text,@origin,@refs,@preImages,@postImages,@revertedAt,@revertedByActivityId)`,
      )
      .run({
        ...activity,
        origin: JSON.stringify(activity.origin),
        refs: JSON.stringify(activity.refs),
        preImages: JSON.stringify(activity.preImages),
        postImages: JSON.stringify(activity.postImages),
      });
    context.changes.push(activityChange(activity));
    return activity;
  }

  public appendEntryChange(
    actor: ActorContext,
    kind: Extract<ActivityKind, 'agent-update' | 'agent-delete'>,
    text: string,
    before: Entry,
    after: Entry,
    context: WriteContext,
    reason?: string,
  ): ActivityItem | null {
    return this.appendVisibleChange(
      actor,
      kind,
      reason === undefined ? text : `${text} — ${reason}`,
      actorRefs(actor, [after.id]),
      [{ entity: 'entry', id: before.id, row: before }],
      [{ entity: 'entry', id: after.id, row: after }],
      context,
    );
  }

  public appendVisibleChange(
    actor: ActorContext,
    kind: ActivityKind,
    text: string,
    refs: ActivityItem['refs'],
    preImages: readonly Snapshot[],
    postImages: readonly Snapshot[],
    context: WriteContext,
  ): ActivityItem | null {
    if (actor.kind === 'owner' && !kind.startsWith('summary-') && kind !== 'revert') return null;
    return this.append({ kind, text, refs, preImages, postImages }, actor, context);
  }

  private activityViews(activities: readonly ActivityItem[]): readonly ActivityView[] {
    const snapshots = activities.flatMap((activity) => activity.postImages);
    const current = new Map<string, Snapshot['row']>();
    const currentEntries = new Map<string, Entry>();
    const load = <Row>(
      entity: Snapshot['entity'],
      rows: readonly Row[],
      idOf: (row: Row) => string,
      map: (row: Row) => Snapshot['row'],
    ): void => {
      for (const row of rows) current.set(`${entity}\0${idOf(row)}`, map(row));
    };
    const ids = (entity: Snapshot['entity']): string[] => [
      ...new Set(
        snapshots.filter((snapshot) => snapshot.entity === entity).map((snapshot) => snapshot.id),
      ),
    ];
    const entryIds = [
      ...new Set([...ids('entry'), ...activities.flatMap((activity) => activity.refs.entryIds)]),
    ];
    if (entryIds.length > 0) {
      const rows = this.db
        .prepare('SELECT * FROM entries WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(entryIds)) as EntryRow[];
      load('entry', rows, (row) => row.id, mapEntry);
      for (const row of rows) {
        const entry = mapEntry(row);
        currentEntries.set(entry.id, entry);
      }
    }
    const collectionIds = ids('collection');
    if (collectionIds.length > 0) {
      load(
        'collection',
        this.db
          .prepare('SELECT * FROM collections WHERE id IN (SELECT value FROM json_each(?))')
          .all(JSON.stringify(collectionIds)) as CollectionRow[],
        (row) => row.id,
        mapCollection,
      );
    }
    const summaryIds = ids('summary');
    if (summaryIds.length > 0) {
      load(
        'summary',
        this.db
          .prepare('SELECT * FROM summaries WHERE id IN (SELECT value FROM json_each(?))')
          .all(JSON.stringify(summaryIds)) as SummaryRow[],
        (row) => row.id,
        mapSummary,
      );
    }

    const latestActivityByEntry = new Map<string, ActivityItem>();
    for (const candidate of [...activities].sort(
      (left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id),
    )) {
      for (const entryId of candidate.refs.entryIds) {
        if (!latestActivityByEntry.has(entryId)) latestActivityByEntry.set(entryId, candidate);
      }
    }
    const tokenLabels = new Map<string, string>();

    return activities.map((activity) => {
      let reason: 'already_reverted' | 'post_image_mismatch' | 'not_reversible' | null = null;
      if (activity.revertedAt !== null) reason = 'already_reverted';
      else if (
        activity.kind === 'revert' ||
        activity.postImages.length === 0 ||
        activityContentExpired(activity.text)
      )
        reason = 'not_reversible';
      else if (
        activity.postImages.some(
          (snapshot) =>
            !snapshotEqual(current.get(`${snapshot.entity}\0${snapshot.id}`) ?? null, snapshot.row),
        )
      ) {
        reason = 'post_image_mismatch';
      }
      const actor = auditActor(activity.origin, tokenLabels);
      const action = auditAction(activity);
      const primaryEntryId = activity.refs.entryIds[0] ?? null;
      let lineage = migrationLineage(activity);
      if (activity.kind === 'revert' && activity.refs.activityId !== undefined) {
        const original = this.getActivity(activity.refs.activityId);
        const originalLineage = original === null ? null : migrationLineage(original);
        if (originalLineage !== null) {
          lineage = {
            fromEntryIds: originalLineage.toEntryIds,
            toEntryIds: originalLineage.fromEntryIds,
            relatedActivityId: activity.refs.activityId,
          };
        }
      }
      const presentationReason = auditReason(activity);
      const presentation: ActivityPresentation = {
        actor,
        action,
        objectLabel: auditObjectLabel(activity),
        primaryEntryId,
        reason: presentationReason,
        attribution: activity.refs.entryIds.map((entryId) => {
          const row = currentEntries.get(entryId) ?? activityEntry(activity, entryId);
          const latest = latestActivityByEntry.get(entryId);
          const latestSnapshot = latest === undefined ? null : activityEntry(latest, entryId);
          const latestIsCurrent =
            row !== null && latest !== undefined && latestSnapshot?.revision === row.revision;
          return {
            entryId,
            originalAuthor:
              row === null
                ? 'unknown'
                : row.author === 'ai'
                  ? ('agent' as const)
                  : ('owner' as const),
            latestModifier:
              row === null || latest === undefined || !latestIsCurrent
                ? null
                : auditActor(latest.origin, tokenLabels),
          };
        }),
        lineage,
        latestAgentTouch:
          actor.kind === 'agent' && primaryEntryId !== null
            ? {
                activityId: activity.id,
                entryId: primaryEntryId,
                at: activity.at,
                actor,
                action,
                reason: presentationReason,
              }
            : null,
      };
      return ActivityViewSchema.parse({
        ...activity,
        revert: { eligible: reason === null, reason },
        presentation,
      });
    });
  }

  private materializeReflectionSlots(from: string, to: string): void {
    const today = this.today();
    const now = this.now().toISOString();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO reflection_slots(
        id,week_start,week_end,status,request_id,requested_at,claimed_at,claimed_token_id,
        claimed_label,claimed_tool,failure,current_version_id,created_at,updated_at,revision
       ) VALUES (?, ?, ?, 'notRequested', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 1)`,
    );
    const hasSourceEntries = this.db.prepare(
      `SELECT 1 FROM entries
       WHERE date >= ? AND date <= ? AND deleted_at IS NULL
       LIMIT 1`,
    );
    const transaction = this.db.transaction(() => {
      let weekStart = mondayOf(from);
      while (weekStart <= to) {
        const weekEnd = addCalendarDays(weekStart, 6);
        if (
          weekEnd <= to &&
          weekEnd < today &&
          hasSourceEntries.get(weekStart, weekEnd) !== undefined
        ) {
          insert.run(this.idFactory(), weekStart, weekEnd, now, now);
        }
        weekStart = addCalendarDays(weekStart, 7);
      }
    });
    transaction();
  }

  private mapReflectionRow(row: ReflectionSlotRow): Reflection {
    const versions = this.db
      .prepare(
        'SELECT * FROM reflection_versions WHERE reflection_id = ? ORDER BY version_number DESC',
      )
      .all(row.id) as ReflectionVersionRow[];
    return mapReflection(row, versions);
  }

  private requireReflection(id: string): Reflection {
    const reflection = this.getReflection(id);
    if (reflection === null) throw new DomainError('NOT_FOUND', `Reflection ${id} was not found`);
    return reflection;
  }

  private requireReflectionForWeek(weekStart: string): Reflection {
    if (!isMonday(weekStart)) invalid('Reflection weekStart must be a Monday');
    const row = this.db
      .prepare('SELECT * FROM reflection_slots WHERE week_start = ?')
      .get(weekStart) as ReflectionSlotRow | undefined;
    if (!row) throw new DomainError('NOT_FOUND', `Reflection week ${weekStart} was not found`);
    return this.mapReflectionRow(row);
  }

  private assertExpectedReflectionRevision(reflection: Reflection, expectedRevision: number): void {
    if (reflection.revision !== expectedRevision) {
      throw new DomainError('CONFLICT', `Reflection changed since revision ${expectedRevision}`, {
        details: { expectedRevision, actualRevision: reflection.revision },
      });
    }
  }

  private queueReflection(
    operation: string,
    id: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
    allowedStatuses: readonly Reflection['status'][],
  ): { readonly reflection: Reflection; readonly activityId: string } {
    if (actor.kind !== 'owner') invalid('Only the owner can request a weekly Reflection');
    validateId(id);
    return this.write.execute(
      operation,
      { id, expectedRevision: options.expectedRevision },
      actor,
      undefined,
      (context) => {
        const before = this.requireReflection(id);
        this.assertExpectedReflectionRevision(before, options.expectedRevision);
        if (!allowedStatuses.includes(before.status)) {
          throw new DomainError('CONFLICT', `Reflection is already ${before.status}`);
        }
        const requestId = this.idFactory();
        this.db
          .prepare(
            `UPDATE reflection_slots SET
              status='queued', request_id=?, requested_at=?, claimed_at=NULL,
              claimed_token_id=NULL, claimed_label=NULL, claimed_tool=NULL, failure=NULL,
              updated_at=?, revision=revision+1
             WHERE id=?`,
          )
          .run(requestId, context.now, context.now, before.id);
        const reflection = this.requireReflection(before.id);
        context.changes.push(reflectionChange(reflection));
        const activity = this.append(
          {
            kind: 'summary-filed',
            text: `${operation === 'retry-reflection' ? 'Retried' : 'Requested'} weekly Reflection for ${before.weekStart}`,
            refs: { ...actorRefs(actor, []), summaryId: before.id },
            preImages: [],
            postImages: [],
          },
          actor,
          context,
        );
        return { reflection, activityId: activity.id };
      },
    );
  }

  private reflectionSourceEntries(
    sourceFrom: string,
    sourceTo: string,
  ): ReflectionVersion['sourceEntries'] {
    return this.db
      .prepare(
        `SELECT id, revision FROM entries
         WHERE date >= ? AND date <= ? AND deleted_at IS NULL
         ORDER BY id`,
      )
      .all(sourceFrom, sourceTo) as ReflectionVersion['sourceEntries'];
  }

  private reflectionVersionIsCurrent(version: ReflectionVersion): boolean {
    return (
      stableJson(version.sourceEntries) ===
      stableJson(this.reflectionSourceEntries(version.sourceFrom, version.sourceTo))
    );
  }

  private getSummaryForWeek(weekStart: string): Summary | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE week_start = ?').get(weekStart) as
      | SummaryRow
      | undefined;
    return row === undefined ? null : mapSummary(row);
  }

  private updateSummaryRow(summary: Summary): void {
    this.db
      .prepare(
        `UPDATE summaries SET text=@text,status=@status,source=@source,token_id=@tokenId,
         updated_at=@updatedAt,saved_entry_id=@savedEntryId,revision=@revision WHERE id=@id`,
      )
      .run(summary);
  }
}

function activityOrigin(actor: ActorContext): ActivityItem['origin'] {
  switch (actor.kind) {
    case 'owner':
      return { actor: 'app', deviceId: actor.deviceId };
    case 'agent':
      return {
        actor: 'mcp',
        tokenId: actor.tokenId,
        tokenLabel: actor.tokenLabel,
        ...(actor.tool === undefined ? {} : { tool: actor.tool }),
        ...(actor.tailscaleUserLogin === undefined
          ? {}
          : { tailscaleUserLogin: actor.tailscaleUserLogin }),
      };
    case 'system':
      return { actor: 'system' };
  }
}

function auditActor(
  origin: ActivityItem['origin'],
  tokenLabels: ReadonlyMap<string, string>,
): ActivityActorSummary {
  if (origin.actor === 'app') return { kind: 'owner', label: 'You' };
  if (origin.actor === 'system') return { kind: 'system', label: 'Journal' };
  const tokenId = origin.tokenId;
  const label =
    origin.tokenLabel ??
    (tokenId === undefined
      ? 'Assistant'
      : (tokenLabels.get(tokenId) ?? `Agent …${tokenId.slice(-6)}`));
  return {
    kind: 'agent',
    label,
    ...(tokenId === undefined ? {} : { tokenId }),
    ...(origin.tool === undefined ? {} : { tool: origin.tool }),
  };
}

function auditAction(activity: ActivityItem): ActivityAction {
  switch (activity.kind) {
    case 'agent-add':
      return 'added';
    case 'agent-update':
      return 'updated';
    case 'agent-delete':
      return 'deleted';
    case 'agent-migration':
      return activity.text.startsWith('Scheduled ') ? 'scheduled' : 'migrated';
    case 'summary-filed':
      return 'filed-summary';
    case 'summary-saved':
      return 'saved-summary';
    case 'revert':
      return 'reverted';
  }
}

function activityEntryContentRedacted(activity: ActivityItem): boolean {
  return (
    activity.refs.entryIds.length > 0 &&
    ![...activity.preImages, ...activity.postImages].some(
      (snapshot) => snapshot.entity === 'entry' && snapshot.row !== null,
    )
  );
}

function auditReason(activity: ActivityItem): string | null {
  if (activityEntryContentRedacted(activity)) return null;
  const separator = activity.text.indexOf(' — ');
  if (separator >= 0) return activity.text.slice(separator + 3).trim() || null;
  if (activity.kind === 'agent-add') {
    const snapshot = activity.postImages.find(
      (candidate) => candidate.entity === 'entry' && candidate.row !== null,
    );
    return snapshot?.entity === 'entry' ? snapshot.row?.source?.trim() || null : null;
  }
  if (activity.kind === 'summary-filed') {
    const snapshot = activity.postImages.find(
      (candidate) => candidate.entity === 'summary' && candidate.row !== null,
    );
    return snapshot?.entity === 'summary' ? snapshot.row?.source?.trim() || null : null;
  }
  return null;
}

function activityEntry(activity: ActivityItem, entryId: string): Entry | null {
  for (const images of [activity.postImages, activity.preImages]) {
    const snapshot = images.find(
      (candidate) => candidate.entity === 'entry' && candidate.id === entryId,
    );
    if (snapshot?.entity === 'entry' && snapshot.row !== null) return snapshot.row;
  }
  return null;
}

function auditObjectLabel(activity: ActivityItem): string {
  const primaryEntryId = activity.refs.entryIds[0];
  if (primaryEntryId !== undefined) {
    if (activity.refs.entryIds.length > 1) return `${activity.refs.entryIds.length} entries`;
    const row = activityEntry(activity, primaryEntryId);
    if (row === null) return `Entry …${primaryEntryId.slice(-6)}`;
    const label = row.text.length <= 100 ? row.text : `${row.text.slice(0, 99)}…`;
    return `“${label}”`;
  }
  const summary = [...activity.postImages, ...activity.preImages].find(
    (snapshot) => snapshot.entity === 'summary' && snapshot.row !== null,
  );
  if (summary?.entity === 'summary' && summary.row !== null) {
    return `weekly summary for ${summary.row.weekStart}`;
  }
  return 'journal activity';
}

function migrationLineage(activity: ActivityItem): ActivityLineage | null {
  if (activity.kind !== 'agent-migration') return null;
  const fromEntryIds: string[] = [];
  const toEntryIds: string[] = [];
  const createdEntryIds: string[] = [];
  for (const [index, before] of activity.preImages.entries()) {
    const after = activity.postImages[index];
    if (before.entity !== 'entry' || after?.entity !== 'entry') continue;
    if (before.row !== null) fromEntryIds.push(before.id);
    if (before.row === null && after.row !== null) createdEntryIds.push(after.id);
    if (after.row !== null) toEntryIds.push(after.id);
  }
  if (fromEntryIds.length === 0 && toEntryIds.length === 0) return null;
  return {
    fromEntryIds: [...new Set(fromEntryIds)],
    toEntryIds: [...new Set(createdEntryIds.length > 0 ? createdEntryIds : toEntryIds)],
    relatedActivityId: activity.refs.activityId ?? activity.revertedByActivityId ?? null,
  };
}
