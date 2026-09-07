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

See the repo docs for architecture, pipeline configuration and deployment:
[`docs/ARCHITECTURE.md`](https://github.com/fr0ster/llm-agent/blob/main/docs/ARCHITECTURE.md), [`docs/PIPELINES.md`](https://github.com/fr0ster/llm-agent/blob/main/docs/PIPELINES.md), [`docs/DEPLOYMENT.md`](https://github.com/fr0ster/llm-agent/blob/main/docs/DEPLOYMENT.md).

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`COPYING`](COPYING) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
