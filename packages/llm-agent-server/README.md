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

## Credentials

**TL;DR** — a config file carries no secrets, only names. Each section that authenticates may say
`credentialRef: <REF>`; the binary reads that account from the environment by one naming rule. Omit the
ref and the section uses its role's default.

### The naming rule

| Set in the environment | You get |
|---|---|
| `<REF>_API_KEY` | an API key — OpenAI, Anthropic, DeepSeek, an OpenAI embedder, Qdrant |
| `<REF>_SERVICE_KEY` | a SAP AI Core service key (the JSON) — the token **and** the API base URL both come from it |
| `<REF>_USER` + `<REF>_PASSWORD` | a login — pg-vector, HANA |

- Set **one** of the three per ref. Two at once is refused as ambiguous; `<REF>_USER` without
  `<REF>_PASSWORD` (or the reverse) is refused.
- A **named** ref must resolve. `credentialRef: OPENAI` with no `OPENAI_*` variable set fails at
  startup, naming `OPENAI`. A ref holding the wrong kind fails, naming the kind wanted and the kind found.
- The same ref named in several sections is **one** credential — one rate-limit bucket.

### Defaults, when a section names no ref

| Section | Default ref | A single-account deployment sets |
|---|---|---|
| each `llm:` entry | `LLM` | `LLM_API_KEY`, or `LLM_SERVICE_KEY` for SAP AI Core |
| `rag.store`, a qdrant `skillPlugins.store` | `RAG_STORE` | `RAG_STORE_API_KEY` (Qdrant) or `RAG_STORE_USER` + `RAG_STORE_PASSWORD` |
| `rag.embedder` | `RAG_EMBEDDER` | `RAG_EMBEDDER_API_KEY`, or `RAG_EMBEDDER_SERVICE_KEY` for SAP AI Core |

The two stores share one default, so they share its one credential kind: a pg-vector or HANA `rag.store`
on the default (a login) beside a qdrant skill store with no ref (an API key) fails at startup with a
wrong-kind error. Name a ref on one of them — usually the skill store's.

A default is read only when the target needs a credential. Where a target can work without one (a Qdrant
without auth, a pg-vector connection that needs no login), an unset default means anonymous.

### Ollama and other targets that send nothing

- An **Ollama LLM** gets a credential only from a `credentialRef` that names one — never the `LLM`
  default, which usually holds a hosted provider's key.
- An **Ollama embedder**, an **in-memory store** and an embedder **`factory`** send nothing from the
  binary, so naming a ref for them is refused.

### Coming from `AICORE_SERVICE_KEY` or `apiKey: ${…}`

- The binary no longer reads `AICORE_SERVICE_KEY`. Set `LLM_SERVICE_KEY` instead (and
  `RAG_EMBEDDER_SERVICE_KEY` for a SAP AI Core embedder) — or keep the variable and name it:
  `credentialRef: AICORE` reads `AICORE_SERVICE_KEY`.
- `apiKey: ${DEEPSEEK_API_KEY}` is refused in YAML. Delete the line and set `LLM_API_KEY`, or write
  `credentialRef: DEEPSEEK`, which reads `DEEPSEEK_API_KEY`.
- SAP AI Core's API base URL is never written in YAML: it travels inside `<REF>_SERVICE_KEY`.

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
