export interface MidnightScheduler {
  stop(): void;
  reschedule(): void;
}

export function calendarDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year ?? '1970'}-${value.month ?? '01'}-${value.day ?? '01'}`;
}

export function millisecondsUntilNextJournalDay(date: Date, timeZone: string): number {
  const start = date.getTime();
  const currentDay = calendarDateInTimeZone(date, timeZone);
  let low = start;
  let high = start + 36 * 60 * 60 * 1_000;
  while (calendarDateInTimeZone(new Date(high), timeZone) === currentDay) {
    high += 12 * 60 * 60 * 1_000;
  }
  while (high - low > 1_000) {
    const middle = Math.floor((low + high) / 2);
    if (calendarDateInTimeZone(new Date(middle), timeZone) === currentDay) low = middle;
    else high = middle;
  }
  return Math.max(high - start + 50, 1);
}

/** Schedules against the journal timezone's next day boundary, including DST changes. */
export function createMidnightScheduler(
  onMidnight: () => void,
  getTimeZone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
): MidnightScheduler {
  let timer: number | undefined;
  let stopped = false;

  const reschedule = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    if (stopped) return;
    const now = new Date();
    timer = window.setTimeout(
      () => {
        onMidnight();
        reschedule();
      },
      millisecondsUntilNextJournalDay(now, getTimeZone()),
    );
  };

  reschedule();
  return {
    reschedule,
    stop: () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    },
  };
}
