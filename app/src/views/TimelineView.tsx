import { Fragment, useEffect, useMemo, useRef } from 'react';
import { EntryRow } from '../components/EntryRow';
import { ReflectionCard } from '../components/ReflectionCard';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { formatLongDate } from '../components/dates';
import { destinationLabel } from '../components/destination';
import type { DisplayPreferences, JournalCollection, JournalEntry } from '../components/types';
import type { AgentTouch, Entry, Reflection } from '../api/types';

interface TimelineViewProps {
  entries: JournalEntry[];
  collectionsById: Record<string, JournalCollection>;
  today: string;
  selectedDate: string | null;
  loading: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  preferences: DisplayPreferences;
  reflections: Reflection[];
  entriesById: Record<string, Entry>;
  latestAgentTouches: Record<string, AgentTouch>;
  online: boolean;
  timezone: string;
  onOpenEntry: (entry: JournalEntry) => void;
  onToggleEntry: (entry: JournalEntry) => void;
  onStartMigration: (entries: JournalEntry[]) => void;
  onLoadEarlier: () => void;
  onRequestReflection: (id: string) => void;
  onRetryReflection: (id: string) => void;
  onRestoreReflection: (id: string, versionId: string) => void;
  onWriteReflection: (weekEnd: string) => void;
}

function entryLayoutSignature(entry: JournalEntry): string {
  return JSON.stringify([
    entry.id,
    entry.revision,
    entry.updatedAt,
    entry.type,
    entry.state,
    entry.text,
    entry.time,
    entry.tags,
    entry.author,
    entry.source,
    entry.migrations,
  ]);
}

export function TimelineView({
  entries,
  collectionsById,
  today,
  selectedDate,
  loading,
  hasEarlier,
  loadingEarlier,
  preferences,
  reflections,
  entriesById,
  latestAgentTouches,
  online,
  timezone,
  onOpenEntry,
  onToggleEntry,
  onStartMigration,
  onLoadEarlier,
  onRequestReflection,
  onRetryReflection,
  onRestoreReflection,
  onWriteReflection,
}: TimelineViewProps) {
  const focusedDateRef = useRef<string | null>(null);
  const scrolledLayoutRef = useRef<string | null>(null);
  // A row can be discovered through several mirrors (bootstrap, paging, SSE,
  // optimistic outbox), but the chronological projection owns one position per
  // canonical entry id.
  const timelineEntries = useMemo(
    () => [...new Map(entries.map((entry) => [entry.id, entry])).values()],
    [entries],
  );
  const dailyEntries = useMemo(
    () => timelineEntries.filter((entry) => entry.collection === null),
    [timelineEntries],
  );
  const leftovers = useMemo(
    () =>
      dailyEntries
        .filter((entry) => entry.type === 'task' && entry.state === 'open' && entry.date < today)
        .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)),
    [dailyEntries, today],
  );
  const sections = useMemo(() => {
    const grouped = new Map<string, JournalEntry[]>();
    for (const entry of timelineEntries) {
      const group = grouped.get(entry.date) ?? [];
      group.push(entry);
      grouped.set(entry.date, group);
    }
    const requiredDate = selectedDate ?? today;
    if (!grouped.has(requiredDate)) grouped.set(requiredDate, []);
    return [...grouped.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([date, dateEntries]) => ({
        date,
        entries: dateEntries.sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        ),
      }));
  }, [selectedDate, timelineEntries, today]);
  const selectedDateFocusKey = useMemo(() => {
    if (!selectedDate) return null;
    const index = sections.findIndex((section) => section.date === selectedDate);
    const layoutSignature =
      index < 0
        ? 'missing'
        : sections
            .slice(0, index)
            .map(
              (section) => `${section.date}:${section.entries.map(entryLayoutSignature).join(',')}`,
            )
            .join('|');
    // The banner renders only the count, not the individual leftover rows. A
    // content-only update to the selected historical task must not re-anchor
    // the viewport when the banner geometry is unchanged.
    const leftoversSignature = String(leftovers.length);
    const preferencesSignature = JSON.stringify([
      preferences.density,
      preferences.showTypeBadges,
      preferences.highlightAiEntries,
    ]);
    return `${selectedDate}:preferences:${preferencesSignature}:leftovers:${leftoversSignature}:sections:${layoutSignature}`;
  }, [leftovers, preferences, sections, selectedDate]);
  const sectionsByDate = useMemo(
    () => new Map(sections.map((section) => [section.date, section] as const)),
    [sections],
  );
  const reflectionsByWeek = useMemo(
    () => new Map(reflections.map((reflection) => [reflection.weekStart, reflection] as const)),
    [reflections],
  );
  const timelineDates = useMemo(
    () =>
      [...new Set([...sections.map((section) => section.date), ...reflectionsByWeek.keys()])].sort(
        (left, right) => right.localeCompare(left),
      ),
    [reflectionsByWeek, sections],
  );

  useEffect(() => {
    if (!selectedDate || !selectedDateFocusKey) {
      focusedDateRef.current = null;
      scrolledLayoutRef.current = null;
      return;
    }
    if (scrolledLayoutRef.current === selectedDateFocusKey) return;
    const target = document.querySelector<HTMLElement>(`[data-day="${CSS.escape(selectedDate)}"]`);
    if (typeof target?.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
    if (target && focusedDateRef.current !== selectedDate) {
      target.focus({ preventScroll: true });
      focusedDateRef.current = selectedDate;
    }
    if (target) scrolledLayoutRef.current = selectedDateFocusKey;
  }, [selectedDate, selectedDateFocusKey]);

  useEffect(() => {
    if (!selectedDate || !selectedDateFocusKey || typeof ResizeObserver === 'undefined') return;
    const target = document.querySelector<HTMLElement>(`[data-day="${CSS.escape(selectedDate)}"]`);
    const parent = target?.parentElement;
    if (!target || !parent) return;

    const observed = [...parent.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== target,
    );
    const targetIndex = [...parent.children].indexOf(target);
    const beforeTarget = observed.filter(
      (element) => [...parent.children].indexOf(element) < targetIndex,
    );
    if (beforeTarget.length === 0) return;

    const measurements = new WeakMap<Element, string>();
    let animationFrame: number | null = null;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const measurement = `${entry.contentRect.width}:${entry.contentRect.height}`;
        const previous = measurements.get(entry.target);
        measurements.set(entry.target, measurement);
        if (previous !== undefined && previous !== measurement) changed = true;
      }
      if (!changed || animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        // Re-pinning the day mid-keystroke would yank the view out from under
        // whoever is typing, so growth above the day is ignored while the
        // composer holds focus.
        if (document.activeElement?.closest('.composer-shell')) return;
        target.scrollIntoView({ block: 'start', behavior: 'auto' });
      });
    });
    for (const element of beforeTarget) observer.observe(element);
    return () => {
      observer.disconnect();
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [selectedDate, selectedDateFocusKey]);

  return (
    <section className="min-h-full" aria-label="Timeline">
      {leftovers.length > 0 ? (
        <aside className="mx-4 mt-3.5 mb-1 flex items-start gap-[11px] rounded-lg border border-border px-[14px] py-[13px] text-fg-mute">
          <Icon name="info" size={16} className="mt-0.5 flex-none" />
          <div>
            <h2 className="text-base font-medium text-fg">
              {leftovers.length} {leftovers.length === 1 ? 'task' : 'tasks'} from an earlier day{' '}
              {leftovers.length === 1 ? 'is' : 'are'} still open
            </h2>
            <p className="pt-0.5 text-sm leading-[1.5] text-fg-mute">
              Decide what to do with each one: move it to today, finish it, or drop it.
            </p>
            <Button
              variant="primary"
              className="mt-[9px]"
              onClick={() => onStartMigration(leftovers)}
            >
              Review them
            </Button>
          </div>
        </aside>
      ) : null}
      {timelineDates.map((date) => {
        const section = sectionsByDate.get(date);
        const sectionEntries = section?.entries ?? [];
        const reflection = reflectionsByWeek.get(date);
        const openCount = sectionEntries.filter(
          (entry) => (entry.type === 'task' || entry.type === 'habit') && entry.state === 'open',
        ).length;
        const count = openCount
          ? `${openCount} open`
          : `${sectionEntries.length} ${sectionEntries.length === 1 ? 'entry' : 'entries'}`;
        return (
          <Fragment key={date}>
            {section ? (
              <section
                className="day-section scroll-mt-1 outline-none"
                data-day={date}
                tabIndex={-1}
                aria-labelledby={`day-${date}`}
              >
                <header className="sticky top-0 z-(--z-day-header) flex min-h-[42px] items-baseline justify-between gap-2.5 bg-bg px-4 pt-3.5 pb-1.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <h2
                      className="overflow-hidden text-base font-semibold tracking-[-0.005em] text-ellipsis whitespace-nowrap"
                      id={`day-${date}`}
                    >
                      {date > today
                        ? `Planning ${formatLongDate(date)}`
                        : date === today
                          ? 'Today'
                          : formatLongDate(date)}
                    </h2>
                    {date === today ? (
                      <span className="flex-none text-xs text-fg-mute">{formatLongDate(date)}</span>
                    ) : null}
                  </div>
                  <span className="flex-none text-xs text-fg-mute">{count}</span>
                </header>
                {sectionEntries.length > 0 ? (
                  sectionEntries.map((entry) => (
                    <EntryRow
                      entry={entry}
                      preferences={preferences}
                      destinationLabel={
                        entry.collection === null
                          ? undefined
                          : destinationLabel(
                              { kind: 'collection', id: entry.collection },
                              collectionsById,
                              today,
                            )
                      }
                      agentTouch={latestAgentTouches[entry.id]}
                      onOpen={onOpenEntry}
                      onToggle={onToggleEntry}
                      key={entry.id}
                    />
                  ))
                ) : (
                  <div className="border-b border-bg-line px-4 pt-[13px] pb-4 text-sm text-fg-mute">
                    <p>
                      {loading
                        ? 'Loading timeline…'
                        : 'No entries yet. The composer is ready when you are.'}
                    </p>
                  </div>
                )}
              </section>
            ) : null}
            {reflection ? (
              <ReflectionCard
                reflection={reflection}
                entriesById={entriesById}
                online={online}
                timezone={timezone}
                onRequest={onRequestReflection}
                onRetry={onRetryReflection}
                onRestore={onRestoreReflection}
                onOpenEntry={onOpenEntry}
                onWrite={onWriteReflection}
              />
            ) : null}
          </Fragment>
        );
      })}
      {hasEarlier ? (
        <div className="flex justify-center px-4 py-4">
          <Button variant="secondary" disabled={loadingEarlier} onClick={onLoadEarlier}>
            {loadingEarlier ? 'Loading earlier…' : 'Earlier'}
          </Button>
        </div>
      ) : null}
      <div className="h-6" aria-hidden="true" />
    </section>
  );
}
