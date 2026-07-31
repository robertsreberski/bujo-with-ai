# Release and contract review

The pass blocked deployment on a non-fail-closed runbook, stale same-day
release backups, non-transactional launchd cutover, an unenforced evidence
ledger, rebuilding after browser tests, overbroad Node support, weak live
adoption/SIGTERM proof, flaky-test and partial-axe CI gates, and a stale
architecture file inventory.

Node support, accessibility/flaky gates, and the architecture inventory were
corrected immediately. The remaining findings were assigned to a dedicated
release-hardening wave: an immutable staged release, exact manifest/archive,
self-restoring cutover, fresh restore-tested snapshot, machine-enforced ledger,
and exact PID/path/listener/asset adoption proof.
