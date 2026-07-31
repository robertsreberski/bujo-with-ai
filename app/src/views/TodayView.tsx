import { useEffect, useMemo, useRef } from 'react';
import { EntryRow } from '../components/EntryRow';
import { Icon } from '../components/Icon';
import { formatLongDate } from '../components/dates';
import type { DisplayPreferences, JournalEntry } from '../components/types';

interface TodayViewProps {
  entries: JournalEntry[];
  today: string;
  selectedDate: string | null;
  preferences: DisplayPreferences;
  onOpenEntry: (entry: JournalEntry) => void;
  onToggleEntry: (entry: JournalEntry) => void;
  onStartMigration: (entries: JournalEntry[]) => void;
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

export function TodayView({
  entries,
  today,
  selectedDate,
  preferences,
  onOpenEntry,
  onToggleEntry,
  onStartMigration,
}: TodayViewProps) {
  const focusedDateRef = useRef<string | null>(null);
  const scrolledLayoutRef = useRef<string | null>(null);
  const dayEntries = useMemo(() => entries.filter((entry) => entry.collection === null), [entries]);
  const leftovers = useMemo(
    () =>
      dayEntries
        .filter((entry) => entry.type === 'task' && entry.state === 'open' && entry.date < today)
        .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)),
    [dayEntries, today],
  );
  const sections = useMemo(() => {
    const grouped = new Map<string, JournalEntry[]>();
    for (const entry of dayEntries) {
      const group = grouped.get(entry.date) ?? [];
      group.push(entry);
      grouped.set(entry.date, group);
    }
    if (!grouped.has(today)) grouped.set(today, []);
    if (selectedDate && !grouped.has(selectedDate)) grouped.set(selectedDate, []);
    return [...grouped.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([date, dateEntries]) => ({
        date,
        entries: dateEntries.sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        ),
      }));
  }, [dayEntries, selectedDate, today]);
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
    <section className="screen" aria-label="Daily log">
      {leftovers.length > 0 ? (
        <aside className="leftovers-card">
          <Icon name="info" size={16} />
          <div>
            <h2>
              {leftovers.length} {leftovers.length === 1 ? 'task' : 'tasks'} from an earlier day{' '}
              {leftovers.length === 1 ? 'is' : 'are'} still open
            </h2>
            <p>Decide what to do with each one: move it to today, finish it, or drop it.</p>
            <button
              className="button button--primary"
              type="button"
              onClick={() => onStartMigration(leftovers)}
            >
              Review them
            </button>
          </div>
        </aside>
      ) : null}
      {sections.map(({ date, entries: sectionEntries }) => {
        const openCount = sectionEntries.filter(
          (entry) => (entry.type === 'task' || entry.type === 'habit') && entry.state === 'open',
        ).length;
        const count = openCount
          ? `${openCount} open`
          : `${sectionEntries.length} ${sectionEntries.length === 1 ? 'entry' : 'entries'}`;
        return (
          <section
            className="day-section"
            data-day={date}
            key={date}
            tabIndex={-1}
            aria-labelledby={`day-${date}`}
          >
            <header className="day-section__header">
              <div>
                <h2 id={`day-${date}`}>{date === today ? 'Today' : formatLongDate(date)}</h2>
                {date === today ? <span>{formatLongDate(date)}</span> : null}
              </div>
              <span>{count}</span>
            </header>
            {sectionEntries.length > 0 ? (
              sectionEntries.map((entry) => (
                <EntryRow
                  entry={entry}
                  preferences={preferences}
                  onOpen={onOpenEntry}
                  onToggle={onToggleEntry}
                  key={entry.id}
                />
              ))
            ) : (
              <div className="empty-day">
                <p>No entries yet. The composer is ready when you are.</p>
              </div>
            )}
          </section>
        );
      })}
      <div className="screen-end" aria-hidden="true" />
    </section>
  );
}
