# Domain and durability review

The first pass found a possible second-writer split brain, shutdown ordering
that could keep accepting traffic while maintenance drained, poisoned corrupt
backup retries, missed pre-03:30 catch-up, migration source/build drift,
acceptance of future schema versions, import cross-reference gaps, deleted
Summary reuse, incomplete Unicode substring search, weak database file modes,
and a non-transactional launchd installer. It also requested failure-injected
backup/restore and lossless round-trip coverage.

The architecture pass added SQL-level cursor pagination, batched Activity
eligibility reads, and cleanup when SQLite construction fails. All were
assigned to the domain/durability wave.
