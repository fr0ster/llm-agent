# @mcp-abap-adt/llm-agent-server

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: GPL v3](https://img.shields.io/badge/License-GPL_v3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

Runnable distribution of SmartAgent (CLI + HTTP server). **Binary-only.**

## Library imports are not supported

Importing from `@mcp-abap-adt/llm-agent-server` as a library is not supported as of 12.0.1. Composition surface lives elsewhere:

- `@mcp-abap-adt/llm-agent-libs` — `SmartAgentBuilder`, `SessionManager`, `LlmAdapter`, `InMemoryMetrics`, etc.
- `@mcp-abap-adt/llm-agent-mcp` — `MCPClientWrapper`, `McpClientAdapter`, connection strategies.
- `@mcp-abap-adt/llm-agent-rag` — `makeRag`, `resolveEmbedder`, prefetch helpers.
- `@mcp-abap-adt/llm-agent` — interfaces and DTOs (`IMetrics`, `IRag`, `Message`, etc.).

(... existing binary documentation continues below ...)

## CLI shipped

- `llm-agent` — the runtime (`llm-agent --config smart-server.yaml`). It is the only command a
  global install (`npm i -g @mcp-abap-adt/llm-agent-server`) puts on your PATH.

### Repository tools (not published)

Two helpers live in the source repository and run from a checkout only:

| From the repo root | Does |
|---|---|
| `npm run models:check` | reports which SAP AI Core models work for chat and which for embeddings |
| `npm run claude:via-agent` | starts `llm-agent` and points the Claude CLI at it (`npm run build` first) |

`models:check` probes through the server's own providers (`SapCoreAIProvider`,
`SapAiCoreEmbedder`) and reads the account by the server's credential rule, so a model it marks ✓
works in the server with the same settings. Every model is probed in both modes; the output is a
capability matrix:

```text
  Model                                  Chat               Embed
  gpt-5                                  ✓ 2007ms           ✗
  text-embedding-3-small                 ✗                  ✓ 1536 dimensions
  nvidia--llama-3.2-nv-embedqa-1b        ✗                  ✗
    ↳ embed declared, but failed: HTTP 400: Embedding Module: Model 'nvidia--llama-3.2-nv-embedqa-1b' requires 'type' …
  Models: 3  Chat: 1/3  Embed: 1/3  Failed: 1
```

| Option (after `npm run models:check --`) | Effect |
|---|---|
| *(none)* | every model in the AI Core `foundation-models` catalog |
| `gpt-4o text-embedding-3-small` | only the named models |
| `--chat` / `--embed` | one mode only |
| `--config <yaml>` | the SAP AI Core models a server config uses, each in the mode of its role, with that role's `credentialRef` and the `temperature` / `maxTokens` the server would send (a classifier derived from `main` at `classifierTemperature` is its own row); non-SAP roles are listed as not checked |
| `--credential-ref <REF>` | the account: reads `<REF>_SERVICE_KEY` (default `LLM` → `LLM_SERVICE_KEY`) |
| `--env-path <file>` | the env file to load (default `.env` in the current directory) |
| `--resource-group <rg>` | AI Core resource group (default `$SAP_AI_RESOURCE_GROUP`, else `default`) |
| `--embed-scenario <s>` | `orchestration` (default) or `foundation-models` |
| `--timeout <ms>` / `--delay <ms>` | per-call timeout (default 60000) / pause between calls (default 2000) |
| `--version` / `--help` | package version / usage |

A ✗ in a mode the catalog does not declare for the model (an embedder under **Chat**) is expected
and printed without a reason. A reason line appears when a declared mode fails, or for a model the
catalog does not list. The exit code is `1` when such a failure exists. Unknown flags are rejected,
and a missing account is an error naming the variable to set.

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

**The skill store shares `RAG_STORE` with `rag.store`.** A qdrant `skillPlugins.store` with no
`credentialRef` reads the `RAG_STORE` default too, so the two share its one credential kind:

- A pg-vector or HANA `rag.store` on `RAG_STORE_USER` + `RAG_STORE_PASSWORD`, beside a qdrant skill
  store you meant to run **anonymously**, fails at startup: the skill store finds a login where it
  wants an API key (wrong kind). "Anonymous" applies only when the default is unset.
- Fix it by naming the ref explicitly on the pg/HANA store — `rag.store.credentialRef: PG` with
  `PG_USER` + `PG_PASSWORD` — and leaving `RAG_STORE_*` unset, so the skill store stays anonymous.
- If the skill store has a key of its own, name that instead: `skillPlugins.store.credentialRef: SKILLS`
  with `SKILLS_API_KEY`. A named ref must resolve, so this does not work for an anonymous store.

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
