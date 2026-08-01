import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { activityDateKey, formatActivityDay, formatTime } from '../components/dates';
import { cn } from '../lib/utils';
import {
  CARD,
  EMPTY_PANEL,
  SECTION,
  SECTION_COPY,
  SECTION_HEADING,
  SECTION_TITLE,
} from './view-classes';
import type { ActivityItem } from '../components/types';

/** The `Before` / `After` caption inside a snapshot diff cell. */
const SNAPSHOT_LABEL = 'text-count font-medium tracking-[0.03em] text-fg-mute uppercase';

interface ReviewViewProps {
  activity: ActivityItem[];
  tokenLabels: Record<string, string>;
  hasMore: boolean;
  loadingMore: boolean;
  timezone: string;
  onLoadMore: () => void;
  onRevert: (activity: ActivityItem) => void;
}

type ActivitySnapshot = ActivityItem['preImages'][number];

interface SnapshotField {
  label: string;
  value: string;
}

const text = (value: string | null): string => value ?? '—';

const snapshotFields = (snapshot: ActivitySnapshot): SnapshotField[] => {
  if (snapshot.row === null) return [{ label: 'Exists', value: 'No' }];
  switch (snapshot.entity) {
    case 'entry':
      return [
        { label: 'Exists', value: 'Yes' },
        { label: 'Text', value: snapshot.row.text },
        { label: 'Type', value: snapshot.row.type },
        { label: 'Status', value: snapshot.row.state },
        { label: 'Date', value: snapshot.row.date },
        { label: 'Time', value: text(snapshot.row.time) },
        {
          label: 'Tags',
          value: snapshot.row.tags.length
            ? snapshot.row.tags.map((tag) => `#${tag}`).join(' ')
            : '—',
        },
        { label: 'Collection', value: text(snapshot.row.collection) },
        { label: 'Author', value: snapshot.row.author === 'ai' ? 'Assistant' : 'You' },
        { label: 'Source', value: text(snapshot.row.source) },
        { label: 'Migrations', value: String(snapshot.row.migrations) },
        { label: 'Deleted', value: text(snapshot.row.deletedAt) },
        { label: 'Updated', value: snapshot.row.updatedAt },
        { label: 'Revision', value: String(snapshot.row.revision) },
      ];
    case 'collection':
      return [
        { label: 'Exists', value: 'Yes' },
        { label: 'Name', value: snapshot.row.name },
        { label: 'Note', value: text(snapshot.row.note) },
        { label: 'Archived', value: text(snapshot.row.archivedAt) },
      ];
    case 'summary':
      return [
        { label: 'Exists', value: 'Yes' },
        { label: 'Week', value: snapshot.row.weekStart },
        { label: 'Text', value: snapshot.row.text },
        { label: 'Status', value: snapshot.row.status },
        { label: 'Source', value: snapshot.row.source },
        { label: 'Saved entry', value: text(snapshot.row.savedEntryId) },
        { label: 'Updated', value: snapshot.row.updatedAt },
        { label: 'Revision', value: String(snapshot.row.revision) },
      ];
  }
};

const changedFields = (
  before: ActivitySnapshot,
  after: ActivitySnapshot,
): Array<{ label: string; before: string; after: string }> => {
  const beforeFields = new Map(snapshotFields(before).map((field) => [field.label, field.value]));
  const afterFields = new Map(snapshotFields(after).map((field) => [field.label, field.value]));
  return [...new Set([...beforeFields.keys(), ...afterFields.keys()])]
    .map((label) => ({
      label,
      before: beforeFields.get(label) ?? '—',
      after: afterFields.get(label) ?? '—',
    }))
    .filter((field) => field.before !== field.after);
};

const reasonLabel = (item: ActivityItem): string | null => {
  if (item.revert.reason === 'already_reverted' || item.revertedAt) return 'Reverted';
  if (item.revert.reason === 'post_image_mismatch') return 'Changed since — newer work preserved';
  if (item.revert.reason === 'not_reversible') return 'Not reversible';
  return null;
};

export function ReviewView({
  activity,
  tokenLabels,
  hasMore,
  loadingMore,
  timezone,
  onLoadMore,
  onRevert,
}: ReviewViewProps) {
  const [reverting, setReverting] = useState<ActivityItem | null>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const groups = useMemo(() => {
    const ordered = [...activity].sort((left, right) => right.at.localeCompare(left.at));
    const byDay = new Map<string, ActivityItem[]>();
    for (const item of ordered) {
      const key = activityDateKey(item.at, timezone);
      const group = byDay.get(key) ?? [];
      group.push(item);
      byDay.set(key, group);
    }
    return [...byDay.entries()];
  }, [activity, timezone]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore || loadingMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      { root: document.getElementById('journal-content'), rootMargin: '120px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  return (
    <section className="min-h-full" aria-label="Assistant activity">
      <div className="mx-4 mt-4 flex items-start gap-2.5 rounded-xl border border-ai-border bg-ai-bg px-[14px] py-[13px]">
        <span className="review-intro__icon grid size-7 flex-none place-items-center rounded-lg border border-ai-border text-ai-fg">
          <Icon name="sparkle" size={15} />
        </span>
        <div>
          <h2 className={SECTION_TITLE}>Automatic changes</h2>
          <p className="pt-0.5 text-sm leading-[1.5] text-fg-mid text-pretty">
            Assistant changes apply immediately and remain visible here. Revert is available while
            the affected entry has not changed again.
          </p>
        </div>
      </div>
      <section className={SECTION} aria-labelledby="activity-heading">
        <header className={SECTION_HEADING}>
          <div>
            <h2 className={SECTION_TITLE} id="activity-heading">
              Recent activity
            </h2>
            <p className={SECTION_COPY}>Every automatic change is attributed and snapshotted.</p>
          </div>
        </header>
        {groups.length > 0 ? (
          <div className="flex flex-col gap-[13px]">
            {groups.map(([day, items]) => (
              <section className="activity-day" key={day} aria-labelledby={`activity-${day}`}>
                <h3
                  className="px-0.5 pb-[5px] text-tag font-medium text-fg-mute"
                  id={`activity-${day}`}
                >
                  {formatActivityDay(items[0]?.at ?? day, timezone)}
                </h3>
                <div className={CARD}>
                  {items.map((item) => {
                    const resolvedReason = reasonLabel(item);
                    const affected = item.preImages.length || item.postImages.length;
                    const originLabel =
                      item.origin.actor === 'mcp'
                        ? `${item.origin.tool ?? 'MCP'} · ${
                            item.origin.tokenId
                              ? (tokenLabels[item.origin.tokenId] ??
                                `Agent …${item.origin.tokenId.slice(-6)}`)
                              : 'Assistant'
                          }`
                        : item.origin.actor === 'app'
                          ? 'Journal app'
                          : 'Journal system';
                    return (
                      <article
                        className="grid grid-cols-[46px_minmax(0,1fr)_auto] items-center gap-2 border-b border-bg-line px-[11px] py-2.5 last:border-b-0 max-[480px]:grid-cols-[40px_minmax(0,1fr)]"
                        key={item.id}
                      >
                        <time
                          className="self-start pt-0.5 text-tag text-fg-mute"
                          dateTime={item.at}
                        >
                          {formatTime(item.at, timezone)}
                        </time>
                        <div className="min-w-0">
                          <p className="text-sm leading-[1.45] text-fg-body text-pretty">
                            {item.text}
                          </p>
                          <span className="block pt-1 font-mono text-count text-fg-mid">
                            {originLabel}
                          </span>
                          <span className="activity-row__kind mt-[5px] inline-flex min-h-5 items-center gap-1 rounded-full border border-ai-border bg-ai-bg px-[7px] py-0.5 text-count text-ai-fg capitalize">
                            <Icon name="sparkle" size={10} /> {item.kind.replaceAll('-', ' ')} ·{' '}
                            {affected} affected {affected === 1 ? 'row' : 'rows'}
                          </span>
                          {affected > 0 ? (
                            <details className="mt-[7px] border-t border-bg-line pt-[5px]">
                              <summary className="min-h-[30px] w-max cursor-pointer text-2xs leading-[30px] text-fg-mid touch:min-h-10 touch:leading-10">
                                View before and after
                              </summary>
                              <div className="flex flex-col gap-[7px] pt-[3px] pb-1">
                                {item.preImages.map((before, index) => {
                                  const after = item.postImages[index];
                                  if (!after) return null;
                                  const fields = changedFields(before, after);
                                  return (
                                    <div
                                      className="border-l-2 border-border-strong pl-2"
                                      key={`${before.entity}:${before.id}`}
                                    >
                                      <strong className="text-count font-medium text-fg-mute capitalize">
                                        {before.entity}
                                      </strong>
                                      <dl className="mt-[3px] grid gap-1">
                                        {fields.map((field) => (
                                          <div
                                            className="grid grid-cols-[64px_minmax(0,1fr)] gap-1.5"
                                            key={field.label}
                                          >
                                            <dt className="text-count text-fg-mute">
                                              {field.label}
                                            </dt>
                                            <dd className="m-0 grid gap-0.5 text-2xs leading-[1.4] text-fg-body [overflow-wrap:anywhere]">
                                              <span>
                                                <b className={SNAPSHOT_LABEL}>Before</b>{' '}
                                                {field.before}
                                              </span>
                                              <span>
                                                <b className={SNAPSHOT_LABEL}>After</b>{' '}
                                                {field.after}
                                              </span>
                                            </dd>
                                          </div>
                                        ))}
                                      </dl>
                                    </div>
                                  );
                                })}
                              </div>
                            </details>
                          ) : null}
                        </div>
                        {item.revert.eligible ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="max-[480px]:col-start-2 max-[480px]:justify-self-start"
                            onClick={() => setReverting(item)}
                          >
                            <Icon name="undo" size={13} /> Revert
                          </Button>
                        ) : resolvedReason ? (
                          <span className="max-w-[126px] text-right text-2xs leading-[1.35] text-fg-mute max-[480px]:col-start-2 max-[480px]:justify-self-start">
                            {resolvedReason}
                          </span>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
            {hasMore ? (
              <Button
                ref={loadMoreRef}
                variant="secondary"
                className="self-center"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore ? 'Loading older activity…' : 'Load older activity'}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className={cn(EMPTY_PANEL, 'min-h-[200px] rounded-xl border border-border')}>
            <Icon name="sparkle" size={18} />
            <h3 className="text-base font-medium text-fg">No automatic changes yet</h3>
            <p className="max-w-[340px] text-sm">
              Automatic additions, edits, migrations, and deletions will appear here.
            </p>
          </div>
        )}
      </section>
      <div className="h-6" aria-hidden="true" />
      {reverting ? (
        <ConfirmDialog
          title="Revert this change?"
          description="Revert succeeds only if no newer edit has changed the affected entry. Your current work will never be overwritten."
          confirmLabel="Revert change"
          onCancel={() => setReverting(null)}
          onConfirm={() => {
            onRevert(reverting);
            setReverting(null);
          }}
        />
      ) : null}
    </section>
  );
}
