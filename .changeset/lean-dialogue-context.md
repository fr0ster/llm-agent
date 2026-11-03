---
"@mcp-abap-adt/llm-agent-libs": minor
---

Reduce coordinator context with compact task previews, paged output retrieval, compact completion events and persisted answer references. Isolate requests without session IDs and clean up their tool state.

Preserve assistant replies and delivery notes verbatim so consent questions and unresolved issues survive context projection and restart. Forward generated request identities and clean up the actual pipeline registries for requests without session IDs.

Preserve removed-step failure references across later turns and restart. Full task views return retained errors without truncation; optional `error_offset` and `error_limit` page diagnostics independently of output, with `errorLength`, `errorOffset` and `nextErrorOffset` metadata.

Resolve historical task failures after successful retries, step completion/skipping, plan completion, or new_request. Coordinator prose never resolves failures; deliver accepts optional `resolves: string[]`, validated against known failed task IDs in the current request, for explicit resolution. Mark internal transcript entries structurally, including deferred events consumed alongside user input, and preserve user text verbatim regardless of note-like prefixes.
