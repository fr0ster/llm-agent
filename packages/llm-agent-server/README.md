# @mcp-abap-adt/llm-agent-server

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: GPL v3](https://img.shields.io/badge/License-GPL_v3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

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

**GNU General Public License v3.0 only** (`GPL-3.0-only`) — see
[`LICENSE`](LICENSE). This is the only package in the monorepo that is not
LGPL: it ships no library exports, so it is the ready-to-run product rather
than something you embed, and it carries the full GPL.

Copyright © 2025–2026 Oleksii Kyslytsia

**Running this server and talking to it over HTTP places no obligation on you
or on your client code** — the GPL has no network trigger. The libraries it
composes stay `LGPL-3.0-only`, so you can still embed those in a closed-source
program. What the GPL asks is that if you distribute a *modified* build of this
server, the corresponding source goes out under the GPL too.

Versions up to and including v20.9.5 were MIT and v21.0.0 was `LGPL-3.0-only`;
a licence change is not retroactive, so those releases keep the terms they
shipped under. Full detail:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
