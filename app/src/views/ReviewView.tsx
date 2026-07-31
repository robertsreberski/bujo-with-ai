import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { activityDateKey, formatActivityDay, formatTime } from '../components/dates';
import type { ActivityItem } from '../components/types';

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
    <section className="screen review-screen" aria-label="Assistant activity">
      <div className="review-intro">
        <span className="review-intro__icon">
          <Icon name="sparkle" size={15} />
        </span>
        <div>
          <h2>Automatic changes</h2>
          <p>
            Assistant changes apply immediately and remain visible here. Revert is available while
            the affected entry has not changed again.
          </p>
        </div>
      </div>
      <section className="activity-section" aria-labelledby="activity-heading">
        <header className="section-heading">
          <div>
            <h2 id="activity-heading">Recent activity</h2>
            <p>Every automatic change is attributed and snapshotted.</p>
          </div>
        </header>
        {groups.length > 0 ? (
          <div className="activity-groups">
            {groups.map(([day, items]) => (
              <section className="activity-day" key={day} aria-labelledby={`activity-${day}`}>
                <h3 id={`activity-${day}`}>{formatActivityDay(items[0]?.at ?? day, timezone)}</h3>
                <div className="activity-card">
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
                      <article className="activity-row" key={item.id}>
                        <time dateTime={item.at}>{formatTime(item.at, timezone)}</time>
                        <div className="activity-row__copy">
                          <p>{item.text}</p>
                          <span className="activity-row__origin">{originLabel}</span>
                          <span className="activity-row__kind">
                            <Icon name="sparkle" size={10} /> {item.kind.replaceAll('-', ' ')} ·{' '}
                            {affected} affected {affected === 1 ? 'row' : 'rows'}
                          </span>
                          {affected > 0 ? (
                            <details className="activity-detail">
                              <summary>View before and after</summary>
                              <div className="activity-detail__rows">
                                {item.preImages.map((before, index) => {
                                  const after = item.postImages[index];
                                  if (!after) return null;
                                  const fields = changedFields(before, after);
                                  return (
                                    <div
                                      className="activity-detail__row"
                                      key={`${before.entity}:${before.id}`}
                                    >
                                      <strong>{before.entity}</strong>
                                      <dl>
                                        {fields.map((field) => (
                                          <div key={field.label}>
                                            <dt>{field.label}</dt>
                                            <dd>
                                              <span>
                                                <b>Before</b> {field.before}
                                              </span>
                                              <span>
                                                <b>After</b> {field.after}
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
                          <span className="activity-row__resolved">{resolvedReason}</span>
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
                className="activity-load-more"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore ? 'Loading older activity…' : 'Load older activity'}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="review-empty">
            <Icon name="sparkle" size={18} />
            <h3>No automatic changes yet</h3>
            <p>Automatic additions, edits, migrations, and deletions will appear here.</p>
          </div>
        )}
      </section>
      <div className="screen-end" aria-hidden="true" />
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
