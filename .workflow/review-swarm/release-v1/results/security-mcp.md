# Security and MCP review

The first pass found route-insensitive malformed-JSON errors, untrusted unknown
tool names reaching logs, absent MCP event replay, a weaker `add_entry` output
schema than the canonical union, an authority-only Origin comparison, and
server-instruction drift. The follow-up architecture pass also found
unbounded per-client SSE buffering.

All findings were assigned to the HTTP/MCP wave with real transport tests,
content-free log assertions, exact event replay, strict scheme-aware origin
checks, canonical tool schemas, and bounded slow-client behavior.
