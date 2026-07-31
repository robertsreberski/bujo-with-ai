import type {
  ActivityView,
  Collection,
  Entry,
  EntryAuthor,
  EntryPatch as CanonicalEntryPatch,
  EntryState as CanonicalEntryState,
  EntryType as CanonicalEntryType,
  Settings,
  Summary,
} from '@journal/server/contracts/app';

export const ENTRY_TYPES = ['task', 'event', 'note', 'idea', 'question', 'habit', 'mood'] as const;

export type EntryType = CanonicalEntryType;
export type EntryState = CanonicalEntryState;
export type Author = EntryAuthor;
export type JournalEntry = Entry;
export type JournalCollection = Collection;
export type JournalSummary = Summary;
export type ActivityItem = ActivityView;
export type Density = Settings['density'];
export type DisplayPreferences = Pick<
  Settings,
  'density' | 'showTypeBadges' | 'highlightAiEntries'
>;

export interface ParsedDraft {
  type: EntryType;
  text: string;
  time: string | null;
  tags: string[];
  /** Collection slug from a `/slug` token, before destination precedence runs. */
  collection: string | null;
  dateShift: 'tomorrow' | null;
  signifierWon: boolean;
  error: string | null;
}

export type EntryPatch = CanonicalEntryPatch;

export const TYPE_LABELS: Record<EntryType, string> = {
  task: 'Task',
  event: 'Event',
  note: 'Note',
  idea: 'Idea',
  question: 'Question',
  habit: 'Habit',
  mood: 'Mood',
};

export const isActionable = (entry: Pick<JournalEntry, 'type'>): boolean =>
  entry.type === 'task' || entry.type === 'habit';

export const stateLabel = (entry: Pick<JournalEntry, 'state' | 'migrations'>): string | null => {
  if (entry.state === 'migrated') return 'Moved forward';
  if (entry.state === 'scheduled') return 'In monthly log';
  if (entry.state === 'cancelled') return 'Dropped';
  if (entry.migrations > 1 && entry.state === 'open') return `Moved ${entry.migrations}×`;
  return null;
};
