---
"@mcp-abap-adt/llm-agent": major
"@mcp-abap-adt/llm-agent-libs": major
"@mcp-abap-adt/llm-agent-server-libs": major
"@mcp-abap-adt/llm-agent-server": major
"@mcp-abap-adt/pg-vector-rag": major
"@mcp-abap-adt/hana-vector-rag": major
"@mcp-abap-adt/qdrant-rag": major
---

Enforce RAG collection ownership AND server authorization for session, user, role and global collections, with library-managed roles, immutable session bindings and positive record ownerScope tags. Registry editors stamp the recorded owner and reject conflicting tags. Require read-only ISessionBindingStore.getUserId and explicit binding before core access or retrieval, including history's server decision; require trusted caller propagation through coordinator/worker inputs and RagAccess at DefaultPipeline initialization plus caller on every request. Require explicit static collection scopes and Result handling for builder build(); reserve history/tools in every scope and require --local-user-id for non-production CLI use. Run the idempotent backend access migration before startup, review rejected-owner reports, and rename existing reserved collections before upgrading; see docs/MIGRATION-v31.md for API migration, session-owned history behavior and backend operational limits.
