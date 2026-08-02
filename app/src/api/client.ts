import {
  ActivityViewSchema,
  ActivitySnapshotSchema,
  AgentTokenSchema,
  CollectionSchema,
  EntrySchema,
  SettingsResponseSchema,
} from '@journal/server/contracts/app';
import { z } from 'zod';

import {
  ActivityListResponseSchema,
  BootstrapResponseSchema,
  CollectionListResponseSchema,
  EntryListResponseSchema,
  LatestSummaryResponseSchema,
  PairResponseSchema,
  RecentlyDeletedListResponseSchema,
  RestoreEntryResponseSchema,
  RewriteSummaryResponseSchema,
  SaveSummaryResponseSchema,
  TagListResponseSchema,
  TimelinePageResponseSchema,
  type ActivityView,
  type AgentToken,
  type BootstrapResponse,
  type Collection,
  type CollectionListResponse,
  type Entry,
  type EntryListResponse,
  type EntryPatch,
  type OwnerEntryCreate,
  type PairResponse,
  type RecentlyDeletedListResponse,
  type RestoreEntryResponse,
  type Settings,
  type SettingsPayload,
  type Summary,
  type TagListResponse,
  type TimelinePageResponse,
} from './types';

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 429;
  }
}

export interface ApiRequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  mutationId?: string;
  ifMatch?: number;
  signal?: AbortSignal;
  schema: z.ZodType<T>;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(response.status, 'invalid_response', 'Server returned invalid JSON.');
  }
}

function searchParams(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export class JournalApiClient {
  async request<T>(path: string, options: ApiRequestOptions<T>): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.mutationId) {
      headers.set('Idempotency-Key', options.mutationId);
      // Kept during the v1 transition; the server canonicalizes both to one id.
      headers.set('X-Mutation-ID', options.mutationId);
    }
    if (options.ifMatch !== undefined) headers.set('If-Match', `"${options.ifMatch}"`);

    let response: Response;
    try {
      response = await fetch(path, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'network_error', 'Journal is unreachable.', error);
    }

    const payload = await readResponseBody(response);
    if (!response.ok) {
      const body = (payload ?? {}) as ApiErrorBody;
      throw new ApiError(
        response.status,
        body.error?.code ?? `http_${response.status}`,
        body.error?.message ?? `Request failed with status ${response.status}.`,
        body.error?.details,
      );
    }

    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(
        502,
        'invalid_response',
        'Server response did not match the API contract.',
        parsed.error.issues,
      );
    }
    return parsed.data;
  }

  pair(signal?: AbortSignal): Promise<PairResponse> {
    return this.request('/api/pair', {
      method: 'POST',
      body: {},
      schema: PairResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  bootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
    return this.request('/api/bootstrap', {
      schema: BootstrapResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  listEntries(
    query: {
      from?: string;
      to?: string;
      collection?: string;
      state?: string;
      type?: string;
      author?: string;
      tag?: string;
      q?: string;
      limit?: number;
      cursor?: string;
    },
    signal?: AbortSignal,
  ): Promise<EntryListResponse> {
    return this.request(`/api/entries${searchParams(query)}`, {
      schema: EntryListResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  timeline(
    query: { to?: string; limit?: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<TimelinePageResponse> {
    return this.request(`/api/timeline${searchParams(query)}`, {
      schema: TimelinePageResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  listCollections(signal?: AbortSignal): Promise<CollectionListResponse> {
    return this.request('/api/collections', {
      schema: CollectionListResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Tag vocabulary ranked by use; feeds best-effort capture suggestions. */
  listTags(signal?: AbortSignal): Promise<TagListResponse> {
    return this.request('/api/tags', {
      schema: TagListResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  listActivity(
    before?: string,
    limit = 50,
  ): Promise<{ items: ActivityView[]; nextCursor: string | null }> {
    return this.request(`/api/activity${searchParams({ before, limit })}`, {
      schema: ActivityListResponseSchema,
    });
  }

  createEntry(input: OwnerEntryCreate, mutationId: string): Promise<{ entry: Entry }> {
    return this.request('/api/entries', {
      method: 'POST',
      body: input,
      mutationId,
      schema: z.strictObject({ entry: EntrySchema }),
    });
  }

  updateEntry(
    id: string,
    patch: EntryPatch,
    mutationId: string,
    expectedRevision?: number,
  ): Promise<{ entry: Entry }> {
    return this.request(`/api/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { patch, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
      mutationId,
      schema: z.strictObject({ entry: EntrySchema }),
    });
  }

  deleteEntry(id: string, mutationId: string, revision?: number): Promise<{ entry: Entry }> {
    return this.request(`/api/entries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      mutationId,
      ...(revision === undefined ? {} : { ifMatch: revision }),
      schema: z.strictObject({ entry: EntrySchema }),
    });
  }

  listRecentlyDeleted(): Promise<RecentlyDeletedListResponse> {
    return this.request('/api/recovery/deleted', {
      schema: RecentlyDeletedListResponseSchema,
    });
  }

  restoreEntry(id: string, expectedRevision?: number): Promise<RestoreEntryResponse> {
    return this.request(`/api/entries/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: expectedRevision === undefined ? {} : { expectedRevision },
      schema: RestoreEntryResponseSchema,
    });
  }

  migrateEntry(
    id: string,
    input: { newEntryId: string; target: string; expectedRevision?: number },
    mutationId: string,
  ): Promise<{ original: Entry; copy: Entry }> {
    return this.request(`/api/entries/${encodeURIComponent(id)}/migrate`, {
      method: 'POST',
      body: input,
      mutationId,
      schema: z.strictObject({ original: EntrySchema, copy: EntrySchema }),
    });
  }

  scheduleEntry(
    id: string,
    input: { copyId: string; month: string; expectedRevision?: number },
    mutationId: string,
  ): Promise<{ original: Entry; copy: Entry; collection?: Collection | undefined }> {
    return this.request(`/api/entries/${encodeURIComponent(id)}/schedule`, {
      method: 'POST',
      body: input,
      mutationId,
      schema: z.strictObject({
        original: EntrySchema,
        copy: EntrySchema,
        collection: CollectionSchema.optional(),
      }),
    });
  }

  createCollection(
    input: { id: string; name: string; note?: string | null },
    mutationId: string,
  ): Promise<{ collection: Collection }> {
    return this.request('/api/collections', {
      method: 'POST',
      body: input,
      mutationId,
      schema: z.strictObject({ collection: CollectionSchema }),
    });
  }

  latestSummary(month?: string): Promise<{ summary: Summary | null }> {
    return this.request(`/api/summary/latest${searchParams({ month })}`, {
      schema: LatestSummaryResponseSchema,
    });
  }

  updateCollection(
    id: string,
    patch: { name?: string; note?: string | null; archived?: boolean },
    mutationId: string,
  ): Promise<{ collection: Collection }> {
    return this.request(`/api/collections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
      mutationId,
      schema: z.strictObject({ collection: CollectionSchema }),
    });
  }

  revertActivity(id: string): Promise<{
    activity: ActivityView;
    rows: Array<z.infer<typeof ActivitySnapshotSchema>>;
  }> {
    return this.request(`/api/activity/${encodeURIComponent(id)}/revert`, {
      method: 'POST',
      body: { expectedActivityId: id },
      schema: z.strictObject({
        activity: ActivityViewSchema,
        rows: z.array(ActivitySnapshotSchema),
      }),
    });
  }

  saveLatestSummary(
    input: {
      summaryId?: string;
      expectedRevision?: number;
    } = {},
  ): Promise<{ summary: Summary; entry: Entry }> {
    return this.request('/api/summary/latest/save', {
      method: 'POST',
      body: input,
      schema: SaveSummaryResponseSchema,
    });
  }

  rewriteLatestSummary(
    input: {
      summaryId?: string;
      expectedRevision?: number;
    } = {},
  ): Promise<{ summary: Summary }> {
    return this.request('/api/summary/latest/rewrite', {
      method: 'POST',
      body: input,
      schema: RewriteSummaryResponseSchema,
    });
  }

  getSettings(): Promise<SettingsPayload> {
    return this.request('/api/settings', { schema: SettingsResponseSchema });
  }

  updateSettings(
    patch: Partial<Pick<Settings, 'density' | 'showTypeBadges' | 'highlightAiEntries'>>,
  ): Promise<SettingsPayload> {
    return this.request('/api/settings', {
      method: 'PATCH',
      body: patch,
      schema: SettingsResponseSchema,
    });
  }

  listTokens(): Promise<{ tokens: AgentToken[] }> {
    return this.request('/api/tokens', {
      schema: z.strictObject({ tokens: z.array(AgentTokenSchema) }),
    });
  }

  createToken(label: string): Promise<{ token: AgentToken; secret: string }> {
    return this.request('/api/tokens', {
      method: 'POST',
      body: { label },
      schema: z.strictObject({ token: AgentTokenSchema, secret: z.string().min(1) }),
    });
  }

  revokeToken(id: string): Promise<{ revoked: true; id: string }> {
    return this.request(`/api/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      schema: z.strictObject({ revoked: z.literal(true), id: z.string().min(1) }),
    });
  }
}

export const journalApi = new JournalApiClient();
