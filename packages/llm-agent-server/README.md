# @mcp-abap-adt/llm-agent-server

Default SmartAgent implementation plus LLM providers, MCP client, HTTP server, and CLI. Depends on `@mcp-abap-adt/llm-agent` (core).

Install this package when you want the out-of-the-box agent without writing your own pipeline. Install only `@mcp-abap-adt/llm-agent` when you're writing a custom agent on our interfaces.

## CLIs shipped

- `llm-agent` — primary runtime (`llm-agent --config smart-server.yaml`).
- `llm-agent-check` — diagnostics CLI.
- `claude-via-agent` — dev convenience wrapper that launches the Claude CLI through a SmartServer.

See the repo root for design specs, migration notes (`docs/MIGRATION-v10.md`), and architectural docs.
