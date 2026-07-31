import { useMemo } from 'react';
import { EntryRow } from '../components/EntryRow';
import { Icon } from '../components/Icon';
import { daysInMonth, formatLongDate, formatMonth, mondayStartOffset } from '../components/dates';
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
    <section className="screen month-screen" aria-label={`${formatMonth(month)} monthly log`}>
      <div className="month-calendar">
        <header className="month-calendar__header">
          <button
            className="icon-button"
            type="button"
            aria-label="Previous month"
            onClick={() => onMonthChange(shiftMonth(month, -1))}
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <h2>{formatMonth(month)}</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Next month"
            onClick={() => onMonthChange(shiftMonth(month, 1))}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </header>
        <div className="calendar-grid" role="group" aria-label={`${formatMonth(month)} calendar`}>
          {WEEKDAYS.map((weekday) => (
            <div className="calendar-grid__weekday" aria-hidden="true" key={weekday}>
              {weekday}
            </div>
          ))}
          {cells.map((cell, index) =>
            cell ? (
              <button
                className={`calendar-day${cell.date === today ? ' calendar-day--today' : ''}`}
                type="button"
                aria-label={`${formatLongDate(cell.date)} — ${dayCounts.get(cell.date) ?? 0} entries`}
                title={`${formatLongDate(cell.date)} — ${dayCounts.get(cell.date) ?? 0} entries`}
                aria-current={cell.date === today ? 'date' : undefined}
                key={cell.date}
                onClick={() => onDaySelect(cell.date)}
              >
                <span>{cell.day}</span>
                {(dayCounts.get(cell.date) ?? 0) > 0 ? (
                  <span className="calendar-day__dot" />
                ) : null}
              </button>
            ) : (
              <span aria-hidden="true" key={`blank-${index}`} />
            ),
          )}
        </div>
      </div>

      <section className="month-section" aria-labelledby="monthly-log-title">
        <header className="section-heading">
          <div>
            <h2 id="monthly-log-title">Monthly log</h2>
            <p>Things that belong to the month, not to a day.</p>
          </div>
          <span>{monthlyEntries.length} items</span>
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
          <div className="section-empty">Nothing belongs to this month yet.</div>
        )}
      </section>

      {habits.length > 0 ? (
        <section className="month-section" aria-labelledby="habits-title">
          <header className="section-heading">
            <div>
              <h2 id="habits-title">Habits</h2>
              <p>A quiet view of the days you showed up.</p>
            </div>
          </header>
          <div className="habit-card">
            {habits.map(({ name, done }) => (
              <div className="habit-row" key={name}>
                <div className="habit-row__heading">
                  <span>{name}</span>
                  <span>
                    {done.size} / {daysInMonth(month)}
                  </span>
                </div>
                <div
                  className="habit-grid"
                  role="list"
                  aria-label={`${name}: ${done.size} of ${daysInMonth(month)} days completed`}
                >
                  {Array.from({ length: daysInMonth(month) }, (_, index) => index + 1).map(
                    (day) => {
                      const date = `${month}-${String(day).padStart(2, '0')}`;
                      return (
                        <span
                          className={done.has(day) ? 'habit-cell habit-cell--done' : 'habit-cell'}
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
        <section className="summary-card" aria-labelledby="weekly-summary-title">
          <div className="summary-card__body">
            <header>
              <Icon name="sparkle" size={13} />
              <h2 id="weekly-summary-title">Weekly summary</h2>
              <span>
                {summary.status === 'stale' ? 'rewrite requested' : 'generated automatically'}
              </span>
            </header>
            <p>{summary.text}</p>
          </div>
          <footer>
            <button
              className="button button--primary"
              type="button"
              disabled={summary.status === 'saved'}
              onClick={() => onSaveSummary(summary)}
            >
              {summary.status === 'saved' ? 'Saved to today' : 'Save to today'}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={summary.status === 'stale'}
              onClick={() => onRewriteSummary(summary)}
            >
              {summary.status === 'stale' ? 'Rewrite requested' : 'Rewrite'}
            </button>
          </footer>
        </section>
      ) : null}
      <div className="screen-end" aria-hidden="true" />
    </section>
  );
}
