# Architecture and performance review

The pass identified four unbounded hot paths: adapter pagination materialized
whole result sets, optimistic entry changes rebuilt all client indexes, every
capture/SSE update cloned the whole IndexedDB mirror, and Activity eligibility
performed per-snapshot queries. It also noted whole-store React subscriptions,
unbounded MCP resource payloads, server-only MCP schema leakage into the app
bundle, runtime layout coupling, and startup/shutdown cleanup gaps.

Bounded server fixes were assigned immediately. Larger client/package changes
are accepted only if the named-hardware release benchmark shows a contract
failure; this keeps the release from acquiring an unmeasured redesign while
still enforcing the documented p95 thresholds.
