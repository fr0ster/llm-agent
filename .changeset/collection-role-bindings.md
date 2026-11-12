---
"@mcp-abap-adt/llm-agent": major
"@mcp-abap-adt/llm-agent-libs": major
"@mcp-abap-adt/llm-agent-server-libs": major
"@mcp-abap-adt/llm-agent-server": major
"@mcp-abap-adt/pg-vector-rag": major
"@mcp-abap-adt/hana-vector-rag": major
"@mcp-abap-adt/qdrant-rag": major
---

Separate collection ownership from shared access through bound roles. Replace the
combined role store with independent role checking and administration contracts,
add persistent collection-role bindings to every backend, and report legacy
role-owned data for administrative resolution without making it global. Update
host wiring, retrieval, hydration, testing helpers, and migration documentation.

Remove collection-role grants when collections are deleted, serialize deletion
against concurrent binding, and fence Qdrant grants by catalog generation.
Restore backend concurrency, role lifecycle, and tool authorization regression
coverage for the separate role-check and role-administration contracts.
