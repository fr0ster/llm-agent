---
"@mcp-abap-adt/sap-aicore-llm": major
---

Prompt caching is enabled by default for Anthropic Claude models through SAP orchestration. `promptCaching?: boolean` uses `options.promptCaching ?? config.promptCaching ?? true`. Enabled requests mark the last system content block and last tool with explicit `cache_control: { type: 'ephemeral' }` breakpoints; `false` omits these markers. Placement and cache lifetime are provider concerns. Cache read/creation reports remain preserved through orchestration and shared agent aggregation.

Migration: replace the former disabled mode with `false` and either former enabled mode with `true`. Omitting the setting now enables both system and tool breakpoints; set `false` explicitly to retain the previous disabled default. Selecting system-only placement is no longer supported.
