import { z } from 'zod';

/** A canonical, upper-case Crockford ULID. */
export const UlidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Expected a canonical ULID.')
  .describe('Canonical upper-case ULID.');

export const MutationIdSchema = UlidSchema.describe(
  'Client-generated ULID identifying one replayable mutation.',
);

export const IdempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7e]{8,128}$/, 'Use 8 to 128 visible ASCII characters.')
  .describe('Caller-generated key used to make a write retry-safe.');

export const CalendarDateSchema = z.iso.date().describe('Calendar date in YYYY-MM-DD form.');

export const WeekStartSchema = CalendarDateSchema.refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay() === 1;
}, 'Expected a Monday week-start date.').describe('Monday in YYYY-MM-DD form.');

export const CalendarMonthSchema = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, 'Expected a calendar month in YYYY-MM form.')
  .describe('Calendar month in YYYY-MM form.');

export const LocalTimeSchema = z.iso
  .time({ precision: -1 })
  .describe('Local display time in HH:MM 24-hour form.');

export const IsoTimestampSchema = z.iso
  .datetime({ offset: true })
  .describe('ISO 8601 timestamp including UTC or an explicit offset.');

export const EntryTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/[\r\n]/.test(value), 'Entry text must be a single line.')
  .describe('Single-line plain text, 1 to 500 characters.');

export const SummaryTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe('Plain-text weekly reflection, 1 to 500 characters.');

export const SourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !/[\r\n]/.test(value), 'Source must be a single line.')
  .describe('Human-readable provenance shown to the owner.');

export const McpSourceSchema = SourceSchema.min(5).describe(
  'Human-readable provenance, 5 to 300 characters.',
);

export const TagSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'Tags use lowercase letters, digits, and hyphens without #.')
  .describe('Lowercase tag without a leading #.');

export const TagsSchema = z
  .array(TagSchema)
  .max(50)
  .refine((tags) => new Set(tags).size === tags.length, 'Tags must be unique.')
  .describe('Unique lowercase tags.');

export const CollectionIdSchema = z
  .string()
  .min(1)
  .max(80)
  .refine(
    (value) => /^[a-z0-9-]+$/.test(value) || /^month:\d{4}-(?:0[1-9]|1[0-2])$/.test(value),
    'Expected a lowercase collection slug or month:YYYY-MM.',
  )
  .describe('Flat collection slug or month:YYYY-MM.');

export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Expected an IANA time-zone identifier.')
  .describe('IANA time-zone identifier used when capture intent was frozen.');

export const CursorSchema = z
  .string()
  .regex(/^.+:\d+$/, 'Expected an epoch-qualified SSE cursor.')
  .describe('SSE cursor in <serverEpoch>:<sequence> form.');

export type Ulid = z.infer<typeof UlidSchema>;
export type MutationId = z.infer<typeof MutationIdSchema>;
export type CalendarDate = z.infer<typeof CalendarDateSchema>;
export type WeekStart = z.infer<typeof WeekStartSchema>;
export type CalendarMonth = z.infer<typeof CalendarMonthSchema>;
export type LocalTime = z.infer<typeof LocalTimeSchema>;
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type CollectionId = z.infer<typeof CollectionIdSchema>;
