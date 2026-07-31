const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const fromDateKey = (value: string): Date => {
  const match = DATE_ONLY.exec(value);
  if (!match) return new Date(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
};

export const toDateKey = (date: Date): string => {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const addDays = (dateKey: string, amount: number): string => {
  const date = fromDateKey(dateKey);
  date.setDate(date.getDate() + amount);
  return toDateKey(date);
};

export const formatLongDate = (value: string): string =>
  new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(
    fromDateKey(value),
  );

export const formatShortDate = (value: string): string =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(fromDateKey(value));

export const formatMonth = (value: string): string =>
  new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
    fromDateKey(`${value}-01`),
  );

export const activityDateKey = (value: string | Date, timeZone?: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(typeof value === 'string' ? new Date(value) : value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((valuePart) => valuePart.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export const previousCalendarDate = (value: string): string => {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

export const formatActivityDay = (value: string, timeZone?: string, now = new Date()): string => {
  const date = new Date(value);
  const todayKey = activityDateKey(now, timeZone);
  const dateKey = activityDateKey(date, timeZone);
  if (dateKey === todayKey) return 'Today';
  if (dateKey === previousCalendarDate(todayKey)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(date);
};

export const formatTime = (value: string, timeZone?: string): string =>
  new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));

export const monthKey = (dateKey: string): string => dateKey.slice(0, 7);

export const moveMonth = (key: string, amount: number): string => {
  const date = fromDateKey(`${key}-01`);
  date.setMonth(date.getMonth() + amount);
  return toDateKey(date).slice(0, 7);
};

export const daysInMonth = (key: string): number => {
  const [year = 0, month = 1] = key.split('-').map(Number);
  return new Date(year, month, 0).getDate();
};

export const mondayStartOffset = (key: string): number => {
  const day = fromDateKey(`${key}-01`).getDay();
  return day === 0 ? 6 : day - 1;
};
