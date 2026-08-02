import {
  ActivityListResponseSchema,
  BootstrapResponseSchema,
  ChangeBatchSchema,
  CollectionListResponseSchema,
  EntryListResponseSchema,
  LatestSummaryResponseSchema,
  PairResponseSchema,
  RecentlyDeletedListResponseSchema,
  RestoreEntryResponseSchema,
  RewriteSummaryResponseSchema,
  SaveSummaryResponseSchema,
  SettingsResponseSchema,
  SseReplayReadySchema,
  SseResetSchema,
  TagListResponseSchema,
  TimelinePageResponseSchema,
  type ActivityView,
  type ActivityItem,
  type AgentToken,
  type BootstrapResponse,
  type Change,
  type ChangeBatch,
  type ChangeOrigin,
  type Collection,
  type DateIntent,
  type Entry,
  type EntryPatch,
  type EntryState,
  type EntryType,
  type OwnerEntryCreate,
  type RecentlyDeletedEntry,
  type Settings,
  type Summary,
  type TagUsage,
  type TimelinePageResponse,
} from '@journal/server/contracts/app';
import type { z } from 'zod';

export type {
  ActivityView,
  ActivityItem,
  AgentToken,
  BootstrapResponse,
  Change,
  ChangeBatch,
  ChangeOrigin,
  Collection,
  DateIntent,
  Entry,
  EntryPatch,
  EntryState,
  EntryType,
  OwnerEntryCreate,
  RecentlyDeletedEntry,
  Settings,
  Summary,
  TagUsage,
  TimelinePageResponse,
};

export type PairResponse = z.infer<typeof PairResponseSchema>;
export type TagListResponse = z.infer<typeof TagListResponseSchema>;
export type EntryListResponse = z.infer<typeof EntryListResponseSchema>;
export type RecentlyDeletedListResponse = z.infer<typeof RecentlyDeletedListResponseSchema>;
export type RestoreEntryResponse = z.infer<typeof RestoreEntryResponseSchema>;
export type CollectionListResponse = z.infer<typeof CollectionListResponseSchema>;
export type ActivityListResponse = z.infer<typeof ActivityListResponseSchema>;
export type SettingsPayload = z.infer<typeof SettingsResponseSchema>;
export type McpStatus = SettingsPayload['assistant'];
export type ResetEvent = z.infer<typeof SseResetSchema>;
export type ChangeKind = Change['kind'];

export {
  ActivityListResponseSchema,
  BootstrapResponseSchema,
  ChangeBatchSchema,
  CollectionListResponseSchema,
  EntryListResponseSchema,
  LatestSummaryResponseSchema,
  PairResponseSchema,
  RecentlyDeletedListResponseSchema,
  RestoreEntryResponseSchema,
  RewriteSummaryResponseSchema,
  SaveSummaryResponseSchema,
  SettingsResponseSchema as SettingsPayloadSchema,
  SseReplayReadySchema,
  SseResetSchema as ResetEventSchema,
  TagListResponseSchema,
  TimelinePageResponseSchema,
};
