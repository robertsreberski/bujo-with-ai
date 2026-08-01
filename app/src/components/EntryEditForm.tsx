import { useMemo, useState, type FormEvent, type RefObject } from 'react';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import {
  DIALOG_ACTIONS_END,
  FIELD,
  FIELD_ERROR,
  FIELD_SMALL,
  FORM_GRID,
  FORM_STACK,
} from './ui/dialog-classes';
import {
  ENTRY_TYPES,
  TYPE_LABELS,
  type EntryPatch,
  type EntryState,
  type EntryType,
  type JournalEntry,
} from './types';

interface EntryEditFormProps {
  entry: JournalEntry;
  onSave: (patch: EntryPatch) => void;
  onCancel: () => void;
  /** Blocks a second submit while the host is still writing the first. */
  saving?: boolean;
  /** The host's focus target, when it wants to open straight into the text field. */
  textRef?: RefObject<HTMLInputElement> | undefined;
}

const normalizeStateForType = (type: EntryType, state: EntryState): EntryState => {
  const actionable = type === 'task' || type === 'habit';
  if (!actionable) return 'logged';
  return state === 'logged' ? 'open' : state;
};

/**
 * The entry edit form and its local draft state. Presentational: it validates
 * and normalizes, then hands the host a finished patch to persist.
 */
export function EntryEditForm({ entry, onSave, onCancel, saving, textRef }: EntryEditFormProps) {
  const [text, setText] = useState(entry.text);
  const [type, setType] = useState<EntryType>(entry.type);
  const [date, setDate] = useState(entry.date);
  const [time, setTime] = useState(entry.time ?? '');
  const [tags, setTags] = useState(entry.tags.join(', '));
  const normalizedTagTokens = useMemo(
    () =>
      tags
        .split(/[\s,]+/)
        .map((tag) => tag.replace(/^#/, '').toLowerCase())
        .filter(Boolean),
    [tags],
  );
  const invalidTags = useMemo(
    () => [...new Set(normalizedTagTokens.filter((tag) => !/^[a-z0-9-]+$/.test(tag)))],
    [normalizedTagTokens],
  );
  const normalizedTags = useMemo(() => [...new Set(normalizedTagTokens)], [normalizedTagTokens]);
  const tagError =
    invalidTags.length > 0
      ? `Tags use letters, numbers, and hyphens only: ${invalidTags.join(', ')}`
      : null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    if (!normalizedText || tagError) return;
    onSave({
      text: normalizedText,
      type,
      state: normalizeStateForType(type, entry.state),
      date,
      time: time || null,
      tags: normalizedTags,
    });
  };

  return (
    <form className={FORM_STACK} onSubmit={save}>
      <label className={FIELD}>
        <span>Text</span>
        <input
          ref={textRef}
          value={text}
          maxLength={500}
          required
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </label>
      <div className={FORM_GRID}>
        <label className={FIELD}>
          <span>Type</span>
          <NativeSelect
            className="w-full"
            value={type}
            onChange={(event) => setType(event.currentTarget.value as EntryType)}
          >
            {ENTRY_TYPES.map((option) => (
              <option value={option} key={option}>
                {TYPE_LABELS[option]}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className={FIELD}>
          <span>Date</span>
          <input
            type="date"
            value={date}
            required
            onChange={(event) => setDate(event.currentTarget.value)}
          />
        </label>
      </div>
      <div className={FORM_GRID}>
        <label className={FIELD}>
          <span>
            Time <small className={FIELD_SMALL}>optional</small>
          </span>
          <input
            type="time"
            value={time}
            onChange={(event) => setTime(event.currentTarget.value)}
          />
        </label>
        <label className={FIELD}>
          <span>
            Tags <small className={FIELD_SMALL}>comma-separated</small>
          </span>
          <input
            value={tags}
            onChange={(event) => setTags(event.currentTarget.value)}
            placeholder="work, design"
            aria-invalid={tagError ? true : undefined}
            aria-describedby={tagError ? 'entry-tags-error' : undefined}
          />
          {tagError ? (
            <small className={FIELD_ERROR} id="entry-tags-error" role="alert">
              {tagError}
            </small>
          ) : null}
        </label>
      </div>
      <div className={DIALOG_ACTIONS_END}>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={Boolean(saving) || !text.trim() || Boolean(tagError)}
        >
          Save changes
        </Button>
      </div>
    </form>
  );
}
