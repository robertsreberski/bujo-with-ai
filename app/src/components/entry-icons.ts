import type { IconName } from './Icon';
import type { EntryType } from './types';

export const entryIcon: Record<EntryType, IconName> = {
  task: 'check',
  event: 'calendar',
  note: 'note',
  idea: 'idea',
  question: 'question',
  habit: 'habit',
  mood: 'mood',
};
