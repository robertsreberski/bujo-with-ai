import {
  ActivityListResponseSchema,
  BootstrapResponseSchema,
  ChangeBatchSchema,
  CollectionListResponseSchema,
  EntryListResponseSchema,
  LatestSummaryResponseSchema,
  PairResponseSchema,
  RewriteSummaryResponseSchema,
  SaveSummaryResponseSchema,
  SettingsResponseSchema,
  SseReplayReadySchema,
  SseResetSchema,
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
  type Settings,
  type Summary,
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
  Settings,
  Summary,
};

export type PairResponse = z.infer<typeof PairResponseSchema>;
export type EntryListResponse = z.infer<typeof EntryListResponseSchema>;
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
  RewriteSummaryResponseSchema,
  SaveSummaryResponseSchema,
  SettingsResponseSchema as SettingsPayloadSchema,
  SseReplayReadySchema,
  SseResetSchema as ResetEventSchema,
};
