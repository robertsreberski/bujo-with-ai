# Release performance evidence

`scripts/benchmark-release.mjs` is the explicit, non-CI release gate for NFR-1. It reports the
machine, runtime, target URLs, raw monotonic samples, p50, p95, maximum, thresholds, cleanup, and
pass/fail status as JSON. A threshold breach exits nonzero. The browser metric starts immediately
before `requestSubmit()` and ends when a `MutationObserver` sees the exact entry text in the
committed DOM. It measures submit-to-DOM-visible work within the 16 ms frame budget, not physical
raster paint.

Build and validate the harness itself:

```sh
export PATH=/Users/robertsreberski/.nvm/versions/node/v22.19.0/bin:$PATH
npm run build
node scripts/benchmark-release.mjs --self-test
```

Run reproducibly against the real production bundle and server with temporary journal data:

```sh
node scripts/benchmark-release.mjs \
  --spawn-isolated \
  --output /tmp/journal-release-benchmark.json
```

After deployment, measure owner capture through Tailscale HTTPS while keeping the MCP read on the
local transport:

```sh
node scripts/benchmark-release.mjs \
  --base-url https://mickey-home.tail8a9beb.ts.net:5178 \
  --mcp-url http://127.0.0.1:5178 \
  --allow-mutating-target \
  --output /tmp/journal-tailnet-release-benchmark.json
```

The non-isolated flag is deliberate. The harness soft-deletes every committed benchmark capture
and revokes its agent token, but the journal's audit contract retains deletion activity and
tombstones. Browser submit-to-DOM-visible samples run offline in an ephemeral context and never
reach the server. The default run performs zero MCP writes and plans 49 server mutations including
one pairing and cleanup, below the conservative 60-mutation budget.
