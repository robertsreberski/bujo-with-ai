import type {
  ActivityAction,
  ActivityActorSummary,
  ActivityPresentation,
  ActivityView,
  Entry,
} from '@journal/server/contracts/app';

const actorFor = (
  activity: ActivityView,
  tokenLabels: Readonly<Record<string, string>>,
): ActivityActorSummary => {
  if (activity.origin.actor === 'app') return { kind: 'owner', label: 'You' };
  if (activity.origin.actor === 'system') return { kind: 'system', label: 'Journal' };
  const tokenId = activity.origin.tokenId;
  return {
    kind: 'agent',
    label:
      activity.origin.tokenLabel ??
      (tokenId === undefined
        ? 'Assistant'
        : (tokenLabels[tokenId] ?? `Agent …${tokenId.slice(-6)}`)),
    ...(tokenId === undefined ? {} : { tokenId }),
    ...(activity.origin.tool === undefined ? {} : { tool: activity.origin.tool }),
  };
};

const actionFor = (activity: ActivityView): ActivityAction => {
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
};

export const activityEntry = (activity: ActivityView, id: string): Entry | null => {
  for (const images of [activity.postImages, activity.preImages]) {
    const snapshot = images.find(
      (candidate) => candidate.entity === 'entry' && candidate.id === id,
    );
    if (snapshot?.entity === 'entry' && snapshot.row !== null) return snapshot.row;
  }
  return null;
};

export const activityEntryLabel = (activity: ActivityView, id: string): string => {
  const entry = activityEntry(activity, id);
  if (entry === null) return `Entry …${id.slice(-6)}`;
  return entry.text.length <= 54 ? entry.text : `${entry.text.slice(0, 53)}…`;
};

export const activityContentRedacted = (activity: ActivityView): boolean =>
  activity.refs.entryIds.length > 0 &&
  ![...activity.preImages, ...activity.postImages].some(
    (snapshot) => snapshot.entity === 'entry' && snapshot.row !== null,
  );

const fallbackReason = (activity: ActivityView): string | null => {
  if (activityContentRedacted(activity)) return null;
  const separator = activity.text.indexOf(' — ');
  if (separator >= 0) return activity.text.slice(separator + 3).trim() || null;
  if (activity.kind === 'agent-add') {
    return activity.refs.entryIds[0] === undefined
      ? null
      : activityEntry(activity, activity.refs.entryIds[0])?.source?.trim() || null;
  }
  return null;
};

/**
 * Old streamed records do not carry server-derived presentation. This fallback
 * stays deterministic and never recovers an entry label from free-form audit
 * text after its snapshots have been redacted.
 */
export function activityPresentation(
  activity: ActivityView,
  tokenLabels: Readonly<Record<string, string>>,
): ActivityPresentation {
  if (activity.presentation !== undefined) {
    const enrich = (actor: ActivityActorSummary): ActivityActorSummary => {
      if (actor.kind !== 'agent' || actor.tokenId === undefined) return actor;
      const label = tokenLabels[actor.tokenId];
      return label === undefined ? actor : { ...actor, label };
    };
    const actor = enrich(activity.presentation.actor);
    const redacted = activityContentRedacted(activity);
    const primaryEntryId = activity.presentation.primaryEntryId;
    return {
      ...activity.presentation,
      actor,
      objectLabel:
        redacted && primaryEntryId !== null
          ? `Entry …${primaryEntryId.slice(-6)}`
          : activity.presentation.objectLabel,
      reason: redacted ? null : activity.presentation.reason,
      attribution: activity.presentation.attribution.map((item) =>
        redacted
          ? { ...item, originalAuthor: 'unknown' as const, latestModifier: null }
          : {
              ...item,
              latestModifier: item.latestModifier === null ? null : enrich(item.latestModifier),
            },
      ),
      latestAgentTouch:
        activity.presentation.latestAgentTouch === null
          ? null
          : {
              ...activity.presentation.latestAgentTouch,
              actor,
              reason: redacted ? null : activity.presentation.latestAgentTouch.reason,
            },
    };
  }
  const actor = actorFor(activity, tokenLabels);
  const action = actionFor(activity);
  const primaryEntryId = activity.refs.entryIds[0] ?? null;
  const reason = fallbackReason(activity);
  const fromEntryIds: string[] = [];
  const toEntryIds: string[] = [];
  const createdEntryIds: string[] = [];
  if (activity.kind === 'agent-migration') {
    activity.preImages.forEach((before, index) => {
      const after = activity.postImages[index];
      if (before.entity !== 'entry' || after?.entity !== 'entry') return;
      if (before.row !== null) fromEntryIds.push(before.id);
      if (before.row === null && after.row !== null) createdEntryIds.push(after.id);
      if (after.row !== null) toEntryIds.push(after.id);
    });
  }
  return {
    actor,
    action,
    objectLabel:
      primaryEntryId === null
        ? 'journal activity'
        : activity.refs.entryIds.length > 1
          ? `${activity.refs.entryIds.length} entries`
          : `“${activityEntryLabel(activity, primaryEntryId)}”`,
    primaryEntryId,
    reason,
    attribution: activity.refs.entryIds.map((entryId) => {
      const entry = activityEntry(activity, entryId);
      return {
        entryId,
        originalAuthor:
          entry === null
            ? 'unknown'
            : entry.author === 'ai'
              ? ('agent' as const)
              : ('owner' as const),
        latestModifier: entry === null ? null : actor,
      };
    }),
    lineage:
      fromEntryIds.length === 0 && toEntryIds.length === 0
        ? null
        : {
            fromEntryIds: [...new Set(fromEntryIds)],
            toEntryIds: [...new Set(createdEntryIds.length > 0 ? createdEntryIds : toEntryIds)],
            relatedActivityId: activity.refs.activityId ?? activity.revertedByActivityId,
          },
    latestAgentTouch:
      actor.kind === 'agent' && primaryEntryId !== null
        ? {
            activityId: activity.id,
            entryId: primaryEntryId,
            at: activity.at,
            actor,
            action,
            reason,
          }
        : null,
  };
}

export const actionPhrase = (action: ActivityAction): string => {
  switch (action) {
    case 'filed-summary':
      return 'filed';
    case 'saved-summary':
      return 'saved';
    default:
      return action;
  }
};
