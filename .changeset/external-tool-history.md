---
"@mcp-abap-adt/llm-agent": patch
"@mcp-abap-adt/llm-agent-libs": patch
"@mcp-abap-adt/llm-agent-server-libs": patch
"@mcp-abap-adt/anthropic-llm": patch
"@mcp-abap-adt/sap-aicore-llm": patch
---

Preserve external assistant tool calls and tool results in model history while still indexing matching results for stateless resumption. Cache external results even when internal tool results are interleaved in the same round.

Supply missing historical tool definitions to Anthropic and Claude models on SAP AI Core. Disable new tool calls when definitions are supplied only to retain completed history.

Map historical tool call IDs to valid Claude wire IDs with a deterministic per-request map shared by calls and results. Reserve existing IDs to avoid collisions, and preserve logical external-result cache keys and input history. OpenAI, DeepSeek and Ollama Chat Completions continue to accept opaque string IDs.

Allow SmartAgent's tool availability registry to be supplied through typed dependencies for embedded agents and tests.

Return globally unique external call IDs per suspension in direct, pipeline, pass-through, and controller responses, retaining an internal mapping to model IDs. SmartAgentSubAgent preserves these IDs unchanged. Match results only to the specific pending call: a new call with identical tool arguments suspends again and cannot reuse a historical result. Classify resume input solely by the returned pending IDs: preserve cumulative messages verbatim (insert missing results after their assistant), or append all delta messages after the stored exchange without comparing or dropping prefixes.
