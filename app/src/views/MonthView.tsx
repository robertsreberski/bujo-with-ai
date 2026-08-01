import { useMemo } from 'react';
import { EntryRow } from '../components/EntryRow';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { daysInMonth, formatLongDate, formatMonth, mondayStartOffset } from '../components/dates';
import { cn } from '../lib/utils';
import { journalActions } from '../store/journal-store';
import {
  CALENDAR_DAY,
  CARD,
  SECTION,
  SECTION_COPY,
  SECTION_COUNT,
  SECTION_EMPTY,
  SECTION_HEADING,
  SECTION_TITLE,
} from './view-classes';
import type { DisplayPreferences, JournalEntry, JournalSummary } from '../components/types';

interface MonthViewProps {
  month: string;
  today: string;
  entries: JournalEntry[];
  summary: JournalSummary | null;
  preferences: DisplayPreferences;
  onMonthChange: (month: string) => void;
  onDaySelect: (date: string) => void;
  onOpenEntry: (entry: JournalEntry) => void;
  onToggleEntry: (entry: JournalEntry) => void;
  onSaveSummary: (summary: JournalSummary) => void;
  onRewriteSummary: (summary: JournalSummary) => void;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const shiftMonth = (month: string, direction: number): string => {
  const [year = 0, monthNumber = 1] = month.split('-').map(Number);
  const value = new Date(year, monthNumber - 1 + direction, 1, 12);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
};

export function MonthView({
  month,
  today,
  entries,
  summary,
  preferences,
  onMonthChange,
  onDaySelect,
  onOpenEntry,
  onToggleEntry,
  onSaveSummary,
  onRewriteSummary,
}: MonthViewProps) {
  const dayCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      if (entry.collection !== null) continue;
      counts.set(entry.date, (counts.get(entry.date) ?? 0) + 1);
    }
    return counts;
  }, [entries]);
  const cells = useMemo(() => {
    const result: Array<{ date: string; day: number } | null> = Array.from(
      { length: mondayStartOffset(month) },
      () => null,
    );
    for (let day = 1; day <= daysInMonth(month); day += 1) {
      result.push({ date: `${month}-${String(day).padStart(2, '0')}`, day });
    }
    while (result.length % 7 !== 0) result.push(null);
    return result;
  }, [month]);
  const monthlyEntries = useMemo(
    () =>
      entries
        .filter((entry) => entry.collection === `month:${month}`)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [entries, month],
  );
  // The month log is a server-owned collection, so an invite files into it by
  // id rather than by date — the same address the schedule action uses.
  const addToMonthlyLog = () =>
    journalActions.focusComposer({ kind: 'collection', id: `month:${month}` });
  const habits = useMemo(() => {
    const names = [
      ...new Set(
        entries
          .filter((entry) => entry.type === 'habit' && entry.collection === null)
          .map((entry) => entry.text),
      ),
    ];
    return names.map((name) => {
      const done = new Set(
        entries
          .filter(
            (entry) =>
              entry.type === 'habit' &&
              entry.collection === null &&
              entry.text === name &&
              entry.date.startsWith(month) &&
              entry.state === 'done',
          )
          .map((entry) => Number(entry.date.slice(-2))),
      );
      return { name, done };
    });
  }, [entries, month]);

  return (
    <section className="min-h-full" aria-label={`${formatMonth(month)} monthly log`}>
      <div className="mx-4 mt-3.5 rounded-xl border border-border p-3 max-[350px]:px-0">
        <header className="flex items-center justify-between px-0.5 pb-2.5">
          <Button
            variant="secondary"
            size="icon"
            className="text-fg-mid"
            aria-label="Previous month"
            onClick={() => onMonthChange(shiftMonth(month, -1))}
          >
            <Icon name="chevronLeft" size={14} />
          </Button>
          <h2 className="text-base font-medium">{formatMonth(month)}</h2>
          <Button
            variant="secondary"
            size="icon"
            className="text-fg-mid"
            aria-label="Next month"
            onClick={() => onMonthChange(shiftMonth(month, 1))}
          >
            <Icon name="chevronRight" size={14} />
          </Button>
        </header>
        <div
          className="grid grid-cols-7 gap-0.5 max-[350px]:gap-px"
          role="group"
          aria-label={`${formatMonth(month)} calendar`}
        >
          {WEEKDAYS.map((weekday) => (
            <div
              className="grid h-[26px] place-items-center text-tag font-medium text-fg-mute"
              aria-hidden="true"
              key={weekday}
            >
              {weekday}
            </div>
          ))}
          {cells.map((cell, index) =>
            cell ? (
              <button
                className={cn(
                  CALENDAR_DAY,
                  cell.date === today &&
                    'calendar-day--today border-border bg-bg-line font-semibold text-fg',
                )}
                type="button"
                aria-label={`${formatLongDate(cell.date)} — ${dayCounts.get(cell.date) ?? 0} entries`}
                title={`${formatLongDate(cell.date)} — ${dayCounts.get(cell.date) ?? 0} entries`}
                aria-current={cell.date === today ? 'date' : undefined}
                key={cell.date}
                onClick={() => onDaySelect(cell.date)}
              >
                <span>{cell.day}</span>
                {(dayCounts.get(cell.date) ?? 0) > 0 ? (
                  <span
                    className={cn(
                      'absolute bottom-1 size-1 rounded-full',
                      cell.date === today ? 'bg-primary' : 'bg-border-strong',
                    )}
                  />
                ) : null}
              </button>
            ) : (
              <span aria-hidden="true" key={`blank-${index}`} />
            ),
          )}
        </div>
      </div>

      <section className={SECTION} aria-labelledby="monthly-log-title">
        <header className={SECTION_HEADING}>
          <div>
            <h2 className={SECTION_TITLE} id="monthly-log-title">
              Monthly log
            </h2>
            <p className={SECTION_COPY}>Things that belong to the month, not to a day.</p>
          </div>
          <div className="flex flex-none items-center gap-1.5">
            <span className={SECTION_COUNT}>{monthlyEntries.length} items</span>
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1.5 size-8"
              aria-label={`Add to ${formatMonth(month)} log`}
              onClick={() => addToMonthlyLog()}
            >
              <Icon name="plus" size={15} />
            </Button>
          </div>
        </header>
        {monthlyEntries.length > 0 ? (
          monthlyEntries.map((entry) => (
            <EntryRow
              entry={entry}
              preferences={preferences}
              onOpen={onOpenEntry}
              onToggle={onToggleEntry}
              key={entry.id}
            />
          ))
        ) : (
          <div className={SECTION_EMPTY}>
            <p>Nothing belongs to {formatMonth(month)} yet.</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2.5"
              onClick={() => addToMonthlyLog()}
            >
              <Icon name="plus" size={13} /> Add to {formatMonth(month)} log
            </Button>
          </div>
        )}
      </section>

      {habits.length > 0 ? (
        <section className={SECTION} aria-labelledby="habits-title">
          <header className={SECTION_HEADING}>
            <div>
              <h2 className={SECTION_TITLE} id="habits-title">
                Habits
              </h2>
              <p className={SECTION_COPY}>A quiet view of the days you showed up.</p>
            </div>
          </header>
          <div className="rounded-xl border border-border px-[13px] py-3">
            {habits.map(({ name, done }) => (
              <div
                className="border-b border-bg-line pb-[11px] last:border-b-0 last:pb-0 [&:not(:first-child)]:pt-[11px]"
                key={name}
              >
                <div className="flex items-baseline justify-between gap-2.5 pb-1.5">
                  <span className="overflow-hidden text-sm font-medium text-ellipsis whitespace-nowrap">
                    {name}
                  </span>
                  <span className="flex-none text-tag text-fg-mute">
                    {done.size} / {daysInMonth(month)}
                  </span>
                </div>
                <div
                  className="grid grid-cols-[repeat(31,minmax(3px,1fr))] gap-0.5"
                  role="list"
                  aria-label={`${name}: ${done.size} of ${daysInMonth(month)} days completed`}
                >
                  {Array.from({ length: daysInMonth(month) }, (_, index) => index + 1).map(
                    (day) => {
                      const date = `${month}-${String(day).padStart(2, '0')}`;
                      return (
                        <span
                          className={cn(
                            'habit-cell aspect-square max-h-[9px] rounded-sm',
                            done.has(day) ? 'habit-cell--done bg-primary' : 'bg-bg-line',
                          )}
                          role="listitem"
                          aria-label={`${formatLongDate(date)}: ${done.has(day) ? 'done' : 'not done'}`}
                          title={`${date}: ${done.has(day) ? 'done' : 'not done'}`}
                          key={day}
                        />
                      );
                    },
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {summary && summary.weekStart.startsWith(month) ? (
        <section
          className={cn(CARD, 'summary-card mx-4 mt-[18px]')}
          aria-labelledby="weekly-summary-title"
        >
          <div className="px-[14px] pt-[13px] pb-3">
            <header className="flex items-center gap-[7px] pb-[7px]">
              <Icon name="sparkle" size={13} className="text-ai-fg" />
              <h2 className="text-sm font-medium" id="weekly-summary-title">
                Weekly summary
              </h2>
              <span className="text-tag text-fg-mute">
                {summary.status === 'stale' ? 'rewrite requested' : 'generated automatically'}
              </span>
            </header>
            <p className="text-base leading-[1.6] text-fg-body text-pretty">{summary.text}</p>
          </div>
          <footer className="flex gap-2 border-t border-border bg-bg-hover px-[14px] py-2.5">
            <Button
              variant="primary"
              disabled={summary.status === 'saved'}
              onClick={() => onSaveSummary(summary)}
            >
              {summary.status === 'saved' ? 'Saved to today' : 'Save to today'}
            </Button>
            <Button
              variant="secondary"
              disabled={summary.status === 'stale'}
              onClick={() => onRewriteSummary(summary)}
            >
              {summary.status === 'stale' ? 'Rewrite requested' : 'Rewrite'}
            </Button>
          </footer>
        </section>
      ) : null}
      <div className="h-6" aria-hidden="true" />
    </section>
  );
}
