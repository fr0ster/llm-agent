---
'@mcp-abap-adt/llm-agent': minor
'@mcp-abap-adt/llm-agent-libs': minor
---

Add optional source trust helpers and contracts, retrieval labels, context and reranker tags, and model-facing tool-result projections while keeping recorded results and traces raw. Preserve separate coordinator, plan-create, plan-revise and worker trust maps through profile resolution and runner interfaces. Existing rendering remains unchanged when trust is absent.

Hard-mode skill selection now loads no skills when no name matches, instead of falling back to all skills. Informational skills require semantic selection. Skill discovery rejects duplicate names with conflicting kinds across directories.
