import type Database from 'better-sqlite3';
import { IsoTimestampSchema, SearchInputSchema } from '../contracts/index.js';
import { DomainError } from './errors.js';
import {
  invalid,
  mapEntry,
  normalizeTag,
  type EntryRow,
  validateDate,
  validateId,
} from './kernel.js';
import { journalSearchNeedles } from './search-query.js';
import type { DayResult, Entry, SearchEntriesInput, SearchEntriesResult } from './types.js';

export interface EntryPageBoundary {
  readonly date: string;
  readonly createdAt: string;
  readonly id: string;
}

export interface EntryPage {
  readonly items: readonly Entry[];
  readonly hasMore: boolean;
}

export interface TimelineQueryOptions {
  readonly db: Database.Database;
  readonly today: () => string;
}

/** Read-only entry projections used by Timeline, Search, and day views. */
export class TimelineQueries {
  private readonly db: Database.Database;
  private readonly today: () => string;

  public constructor(options: TimelineQueryOptions) {
    this.db = options.db;
    this.today = options.today;
  }

  public getEntry(id: string, options: { includeDeleted?: boolean } = {}): Entry | null {
    validateId(id);
    const row = this.db
      .prepare(
        `SELECT * FROM entries WHERE id = ? ${options.includeDeleted === true ? '' : 'AND deleted_at IS NULL'}`,
      )
      .get(id) as EntryRow | undefined;
    return row === undefined ? null : mapEntry(row);
  }

  public requireEntry(id: string, options: { includeDeleted?: boolean } = {}): Entry {
    const entry = this.getEntry(id, options);
    if (entry === null) throw new DomainError('NOT_FOUND', `Entry ${id} was not found`);
    return entry;
  }

  public searchEntries(input: SearchEntriesInput = {}): SearchEntriesResult {
    validateSearch(input);
    const { predicate, params } = entryPredicate(input);
    const total = this.countEntries(input);
    const limit = input.limit ?? 25;
    const offset = input.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entries e WHERE ${predicate}
         ORDER BY e.date DESC, e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as EntryRow[];
    return { total, entries: rows.map(mapEntry) };
  }

  public countEntries(input: SearchEntriesInput = {}): number {
    validateSearch(input);
    const { predicate, params } = entryPredicate(input);
    return (
      this.db
        .prepare(`SELECT count(*) AS count FROM entries e WHERE ${predicate}`)
        .get(...params) as { count: number }
    ).count;
  }

  public pageEntries(
    input: Omit<SearchEntriesInput, 'limit' | 'offset'> & { readonly limit: number },
    before?: EntryPageBoundary,
  ): EntryPage {
    validateSearch(input);
    if (before !== undefined) {
      validateDate(before.date);
      if (!IsoTimestampSchema.safeParse(before.createdAt).success)
        invalid('Invalid entry cursor timestamp');
      validateId(before.id);
    }
    const { predicate, params } = entryPredicate(input);
    const boundary =
      before === undefined
        ? ''
        : ` AND (e.date < ? OR (e.date = ? AND e.created_at < ?)
             OR (e.date = ? AND e.created_at = ? AND e.id < ?))`;
    if (before !== undefined) {
      params.push(
        before.date,
        before.date,
        before.createdAt,
        before.date,
        before.createdAt,
        before.id,
      );
    }
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entries e WHERE ${predicate}${boundary}
         ORDER BY e.date DESC, e.created_at DESC, e.id DESC LIMIT ?`,
      )
      .all(...params, input.limit + 1) as EntryRow[];
    return { items: rows.slice(0, input.limit).map(mapEntry), hasMore: rows.length > input.limit };
  }

  public listDay(date = this.today()): DayResult {
    validateDate(date);
    const entries = (
      this.db
        .prepare(
          `SELECT * FROM entries WHERE date = ? AND collection IS NULL AND deleted_at IS NULL
           ORDER BY created_at DESC, id DESC`,
        )
        .all(date) as EntryRow[]
    ).map(mapEntry);
    const isToday = date === this.today();
    const leftovers = isToday
      ? (
          this.db
            .prepare(
              `SELECT * FROM entries WHERE date < ? AND collection IS NULL AND type = 'task'
               AND state = 'open' AND deleted_at IS NULL ORDER BY date ASC, created_at ASC`,
            )
            .all(date) as EntryRow[]
        ).map(mapEntry)
      : [];
    return { date, isToday, entries, leftovers: { count: leftovers.length, entries: leftovers } };
  }
}

function validateSearch(input: SearchEntriesInput): void {
  const canonical = {
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.author === undefined ? {} : { author: input.author }),
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    ...(input.collection === undefined ? {} : { collection: input.collection }),
    ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
    ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
    limit: input.limit ?? 25,
  };
  SearchInputSchema.parse(canonical);
  if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) {
    invalid('offset must be a non-negative integer');
  }
}

function addWhere(where: string[], params: unknown[], clause: string, value: unknown): void {
  where.push(clause);
  params.push(value);
}

function ftsPrefixQuery(value: string): string {
  const tokens = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return '"journal-no-token-sentinel"';
  return tokens.map((token) => `"${token}"*`).join(' AND ');
}

function entryPredicate(input: SearchEntriesInput): { predicate: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.includeDeleted !== true) where.push('e.deleted_at IS NULL');
  if (input.excludeMonthlyCollections === true) {
    where.push("(e.collection IS NULL OR e.collection NOT LIKE 'month:%')");
  }
  if (input.type !== undefined) addWhere(where, params, 'e.type = ?', input.type);
  if (input.state !== undefined) addWhere(where, params, 'e.state = ?', input.state);
  if (input.author !== undefined) addWhere(where, params, 'e.author = ?', input.author);
  if (input.dateFrom !== undefined) addWhere(where, params, 'e.date >= ?', input.dateFrom);
  if (input.dateTo !== undefined) addWhere(where, params, 'e.date <= ?', input.dateTo);
  if (input.collection === 'daily') where.push('e.collection IS NULL');
  else if (input.collection !== undefined)
    addWhere(where, params, 'e.collection = ?', input.collection);
  const exactTag =
    input.tag ?? (input.query?.trim().startsWith('#') ? input.query.trim().slice(1) : undefined);
  if (exactTag !== undefined && exactTag !== '') {
    const tag = normalizeTag(exactTag);
    where.push('EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)');
    params.push(tag);
  } else if (input.query !== undefined && input.query.trim() !== '') {
    const needles = journalSearchNeedles(input.query);
    for (const needle of needles) {
      where.push(
        `(e.rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)
          OR instr(journal_search_normalize(e.text), ?) > 0
          OR instr(journal_search_normalize(e.tags), ?) > 0)`,
      );
      params.push(ftsPrefixQuery(needle), needle, needle);
    }
  }
  return { predicate: where.length === 0 ? '1 = 1' : where.join(' AND '), params };
}
