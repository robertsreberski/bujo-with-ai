import type { CreateEntryInput } from '../store/models';
import { humanizeSlug, nextCalendarDate, type ResolvedDestination } from './destination';
import type { ParsedDraft } from './types';

/** The collection a capture has to mint before it can file into it. */
export interface CollectionSeed {
  id: string;
  name: string;
  note: null;
}

export interface SubmitPlan {
  /** `createEntry` payload minus its id, which the caller mints. */
  entry: Omit<CreateEntryInput, 'id'>;
  /** Non-null when the destination names a slug the mirror has never seen. */
  collection: CollectionSeed | null;
}

/**
 * Turns a parsed draft plus its resolved destination into the exact store calls
 * a submit performs. Pure so the date/collection mapping — the part that decides
 * whether an entry lands on the right day — is unit-testable without React.
 *
 * The date mapping mirrors `createCaptureContext`, which prefers `dateShift`
 * over `date`:
 *
 * | destination                | fields                            |
 * | -------------------------- | --------------------------------- |
 * | `{collection, id}`         | `collection: id`, `date` if stated|
 * | `{date}` equal to today    | `collection: null`                |
 * | `{date}` equal to tomorrow | `collection: null, dateShift`     |
 * | `{date}` any other day     | `collection: null, date`          |
 *
 * Tomorrow deliberately travels as `dateShift` rather than an absolute `date`:
 * an offline capture that replays after the browser rolls past midnight must
 * still land on the day the owner meant, which is what the shift intent encodes.
 */
export function planSubmit(
  parsed: ParsedDraft,
  resolved: ResolvedDestination,
  today: string,
): SubmitPlan {
  return {
    entry: entryInput(parsed, resolved, today),
    collection:
      resolved.createsCollection && resolved.destination.kind === 'collection'
        ? { id: resolved.destination.id, name: humanizeSlug(resolved.destination.id), note: null }
        : null,
  };
}

function entryInput(
  parsed: ParsedDraft,
  resolved: ResolvedDestination,
  today: string,
): Omit<CreateEntryInput, 'id'> {
  const destination = resolved.destination;
  const base = {
    text: parsed.text,
    type: parsed.type,
    time: parsed.time,
    tags: parsed.tags,
  };
  // A filed capture states its day only when the owner named one; left unsaid,
  // the server still stamps the filing date. `dateShift` never travels with a
  // collection — the shift intent exists to survive a midnight rollover on the
  // daily log, and a collection filing has no day to roll over.
  if (destination.kind === 'collection') {
    return {
      ...base,
      collection: destination.id,
      ...(resolved.statedDate === null ? {} : { date: resolved.statedDate }),
    };
  }
  if (destination.date === today) return { ...base, collection: null };
  if (destination.date === nextCalendarDate(today)) {
    return { ...base, collection: null, dateShift: 'tomorrow' };
  }
  return { ...base, collection: null, date: destination.date };
}
