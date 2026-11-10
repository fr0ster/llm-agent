---
"@mcp-abap-adt/llm-agent": major
"@mcp-abap-adt/llm-agent-libs": major
"@mcp-abap-adt/llm-agent-server-libs": major
"@mcp-abap-adt/llm-agent-server": major
"@mcp-abap-adt/pg-vector-rag": major
"@mcp-abap-adt/hana-vector-rag": major
"@mcp-abap-adt/qdrant-rag": major
---

Enforce RAG collection ownership AND server authorization for session, user, role and global collections, with library-managed roles, immutable session bindings and positive record ownerScope tags. Require explicit caller/access wiring, explicit static collection scopes and Result handling for builder build(); reserve history/tools in every scope and require --local-user-id for non-production CLI use. Run the idempotent backend access migration before startup, review rejected-owner reports, and rename existing reserved collections before upgrading; see docs/MIGRATION-v31.md for API migration, session-owned history behavior and backend operational limits.
