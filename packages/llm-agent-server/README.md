# @mcp-abap-adt/llm-agent-server

Runnable distribution of SmartAgent (CLI + HTTP server). **Binary-only.**

## Library imports are not supported

Importing from `@mcp-abap-adt/llm-agent-server` as a library is not supported as of 12.0.1. Composition surface lives elsewhere:

- `@mcp-abap-adt/llm-agent-libs` — `SmartAgentBuilder`, `SessionManager`, `makeLlm`, `InMemoryMetrics`, etc.
- `@mcp-abap-adt/llm-agent-mcp` — `MCPClientWrapper`, `McpClientAdapter`, connection strategies.
- `@mcp-abap-adt/llm-agent-rag` — `makeRag`, `resolveEmbedder`, prefetch helpers.
- `@mcp-abap-adt/llm-agent` — interfaces and DTOs (`IMetrics`, `IRag`, `Message`, etc.).

(... existing binary documentation continues below ...)

## CLIs shipped

- `llm-agent` — primary runtime (`llm-agent --config smart-server.yaml`).
- `llm-agent-check` — diagnostics CLI.
- `claude-via-agent` — dev convenience wrapper that launches the Claude CLI through a SmartServer.

See the repo root for design specs, migration notes (`docs/MIGRATION-v10.md`), and architectural docs.
