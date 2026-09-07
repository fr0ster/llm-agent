# SmartAgent — a composable framework for LLM pipelines

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

**Build an LLM pipeline of any shape — from a single ReAct tool-loop to a
plan-first controller with durable, resumable state — by composing interfaces
rather than writing glue.** Every variation point the consumer should own is a
strategy they can swap; every backend is a factory they can register.

It ships two ways:

- **As a server.** `llm-agent` is an OpenAI- and Anthropic-compatible HTTP
  endpoint. Point Claude CLI, Cline, Goose, or anything that speaks
  `/v1/chat/completions` at it, and it answers with the whole pipeline behind it
  — no client changes.
- **As libraries.** Embed `SmartAgentBuilder` in your own process, or take only
  the interface package and implement the seams yourself.

## What it does

### Pipelines are plugins, selected by name

The shape of the run is configuration, not code. `pipeline: { name, config }`
resolves against a plugin registry; six pipelines are built in, and a deployment
adds its own by exporting an `IPipelinePlugin` (a name collision with a built-in
fails loud at startup rather than shadowing it).

| `name` | Shape |
|---|---|
| `flat` | Single ReAct tool-loop, no coordinator. The default when `pipeline:` is omitted. |
| `linear` | Ordered plan → dispatch coordinator (`one-shot` / `replan-on-error` / `skill-steps` planning; `self` / `subagent` / `hybrid` dispatch). |
| `controller` | **The maintained interpreter.** Deterministic coordinator + three opaque subagent roles (evaluator / planner / executor), plan-first step loop, reviewer/finalizer split, durable per-session bundle, stateless suspend/resume. |
| `controller-weak` | Same, with the fine-grained **weak-executor** planner — one action per step, for smaller executor models that cannot self-expand a coarse step. |
| `dag` ⚠️ | Legacy. Planner → parallel workers → finalizer, on its own step interpreter. Selectable for backward compatibility only. |
| `stepper` ⚠️ | Legacy. Composition flow (`cyclic-react` / `planned-react` / `deep-stepper`). Selectable for backward compatibility only. |

The three subagent roles are independent LLM endpoints, so a heavy planner and a
light executor can sit on different providers and models in the same run.

> ⚠️ `dag` and `stepper` still run, but they are no longer the active development
> path and receive no new planner/replan/metering work. Choose `controller` for
> anything new — and do not migrate a `dag`/`stepper` config onto it, since the
> controller interpreter was not designed to drive those flows. Parallel step
> execution is available on the controller through the `maxActiveSteps` budget.

See [PIPELINES.md](docs/PIPELINES.md) for each dialect's full config.

### Context management is explicit and budgeted

Nothing about the context window is left to chance:

- **History** — `historyRecencyWindow` bounds what is replayed;
  `historyAutoSummarizeLimit` compresses older turns into a summary.
- **Tool-loop context** — a swappable `toolLoopContextStrategyFactory` decides
  what survives between tool rounds, so a long tool loop does not simply
  accumulate until the model chokes.
- **Per-step budgets, not one global cap.** A controller run carries
  `maxSteps`, `maxRetries`, `maxRewinds`, `maxToolCalls`, `perStepTimeoutMs`,
  `maxStepAttempts`, and render caps (`maxBoardChars`, `maxDigestChars`,
  `maxIntentChars`). A step that stops converging is cut and replanned instead
  of livelocking the run.
- **Token accounting** — every LLM *and* embedder call is metered through
  `IRequestLogger` and rolled up per session; read it back from `/v1/usage`.

### RAG is a composition, not a backend

Store and embedder are chosen independently and resolved from registries:

- **Stores** — `in-memory`, `qdrant`, `hana-vector` (SAP HANA Cloud Vector
  Engine), `pg-vector` (PostgreSQL + pgvector).
- **Embedders** — `ollama`, `openai`, `sap-ai-core`, or your own factory
  registered by name.
- **Hybrid retrieval** — vector and keyword scores are blended
  (`vectorWeight` / `keywordWeight`), with cosine dedup (`dedupThreshold`).
  Omit the embedder entirely and tool selection falls back to BM25 keyword
  matching — the whole stack still runs with no embedding service at all.
- **Runtime domain knowledge.** A second, separate skills-RAG (`skillPlugins:`)
  lets the plugin-host fetch consumer-supplied skills and serve them by recall.
  The engine bundles no domain knowledge and vendors none — it is *gnosticized*
  at runtime, which is why it stays agnostic (and cleanly licensed).

### MCP integration, several servers at once

- **Transports** — `stdio`, `sse`, `stream-http`, `embedded` (in-process, for
  testing), or `auto` to detect from the URL.
- **Many servers simultaneously**, with `IToolNamespace` prefixing so two servers
  exposing the same tool name stay individually callable.
- **Tool selection is a strategy** — `top-k` (default) or `threshold` with a
  `minScore`; the set is rebuilt **per step**, so each step gets the tools that
  step needs rather than a set chosen once from the opening prompt.
- **Failure is loud and typed** — per-tool timeouts, a `CircuitBreaker`, and a
  consumer-swappable `IMcpFailureClassifier`. Tool errors reach the planner as
  errors, so it can replan instead of confabulating around a dead tool.
- **English-on-English tool search.** Tool descriptions are translated to English
  at catalog-build time and the planner emits English step instructions, so tool
  selection is stable regardless of the user's language — while the finalizer
  still answers in the user's language.

### Everything the consumer should own is a seam

A plugin module can contribute `pipelinePlugins`, `stageHandlers`,
`embedderFactories`, `mcpClients`, `clientAdapters`, and `apiAdapters`. The core
package has zero provider dependencies: consumers depend on interfaces, and any
`ILlm`, `IEmbedder`, `IRag`, or `IMcpConnectionStrategy` implementation drops in.

### HTTP surface

`/v1/chat/completions` (OpenAI, streaming), `/v1/messages` (Anthropic),
`/v1/models`, `/v1/embedding-models`, `/v1/sessions`, `/v1/usage`, `/v1/config`,
`/v1/health`. Each is also served without the `/v1` prefix.

## Packages

| Package | What it is |
|---|---|
| [`@mcp-abap-adt/llm-agent`](packages/llm-agent/README.md) | Core interfaces, types, `MissingProviderError`, lightweight helpers (`CircuitBreaker`, `FallbackRag`, LLM call strategies, `ToolCache`, adapters, normalizers). Zero provider dependencies. |
| [`@mcp-abap-adt/llm-agent-mcp`](packages/llm-agent-mcp/README.md) | `MCPClientWrapper`, `McpClientAdapter`, `createDefaultMcpClient`, and MCP connection strategies. |
| [`@mcp-abap-adt/llm-agent-rag`](packages/llm-agent-rag/README.md) | RAG/embedder composition — `makeRag` (async), `resolveEmbedder` (sync), prefetch helpers, backend factories. |
| [`@mcp-abap-adt/llm-agent-libs`](packages/llm-agent-libs/README.md) | Core composition runtime: `SmartAgentBuilder`, `SmartAgent`, pipeline, sessions, history, resilience, observability, plugins, skills, `makeLlm`/`makeDefaultLlm`. |
| [`@mcp-abap-adt/llm-agent-server-libs`](packages/llm-agent-server-libs/README.md) | SmartServer composition library: `SmartServer`, `buildStepperRoot`/`buildFromComposition`, `StepperCoordinatorHandler`, coordinator config parsing, sessions, and the pipeline builder-factories (`LinearFactory`, `DagFactory`, `CyclicFactory`, `PlannedFactory`, `DeepStepperFactory`, `ControllerFactory`). Importable. |
| [`@mcp-abap-adt/llm-agent-server`](packages/llm-agent-server/README.md) | **Binary only** — CLI (`llm-agent`, `llm-agent-check`, `claude-via-agent`) + HTTP `SmartServer`. Not importable as a library. Thin wrapper over `llm-agent-server-libs`. |
| [`@mcp-abap-adt/openai-llm`](packages/openai-llm/README.md) | OpenAI LLM provider (`OpenAIProvider`). |
| [`@mcp-abap-adt/anthropic-llm`](packages/anthropic-llm/README.md) | Anthropic LLM provider (`AnthropicProvider`). |
| [`@mcp-abap-adt/deepseek-llm`](packages/deepseek-llm/README.md) | DeepSeek LLM provider (`DeepSeekProvider`, extends OpenAI-compatible). |
| [`@mcp-abap-adt/sap-aicore-llm`](packages/sap-aicore-llm/README.md) | SAP AI Core LLM provider via `@sap-ai-sdk/orchestration`. |
| [`@mcp-abap-adt/ollama-llm`](packages/ollama-llm/README.md) | Ollama LLM provider (`OllamaProvider`, extends OpenAI-compatible). |
| [`@mcp-abap-adt/openai-embedder`](packages/openai-embedder/README.md) | OpenAI embeddings (`OpenAiEmbedder`). |
| [`@mcp-abap-adt/ollama-embedder`](packages/ollama-embedder/README.md) | Ollama embeddings + RAG (`OllamaEmbedder`, `OllamaRag`). |
| [`@mcp-abap-adt/sap-aicore-embedder`](packages/sap-aicore-embedder/README.md) | SAP AI Core embeddings (`SapAiCoreEmbedder`). |
| [`@mcp-abap-adt/qdrant-rag`](packages/qdrant-rag/README.md) | Qdrant vector store RAG (`QdrantRag`, `QdrantRagProvider`). |
| [`@mcp-abap-adt/hana-vector-rag`](packages/hana-vector-rag/README.md) | SAP HANA Cloud Vector Engine RAG (`HanaVectorRag`, `HanaVectorRagProvider`). Optional peer. |
| [`@mcp-abap-adt/pg-vector-rag`](packages/pg-vector-rag/README.md) | PostgreSQL + pgvector RAG (`PgVectorRag`, `PgVectorRagProvider`). Optional peer. |

## Quick install

### (a) Server-managed declarative (most common)

Install server + exactly the peers your `smart-server.yaml` references:

```bash
# Fully local — Ollama LLM + Ollama embeddings
npm install @mcp-abap-adt/llm-agent-server \
            @mcp-abap-adt/ollama-embedder

# DeepSeek LLM + Ollama embeddings
npm install @mcp-abap-adt/llm-agent-server \
            @mcp-abap-adt/deepseek-llm \
            @mcp-abap-adt/ollama-embedder

# SAP AI Core LLM + SAP AI Core embeddings + Qdrant RAG
npm install @mcp-abap-adt/llm-agent-server \
            @mcp-abap-adt/sap-aicore-llm \
            @mcp-abap-adt/sap-aicore-embedder \
            @mcp-abap-adt/qdrant-rag
```

A missing peer throws `MissingProviderError` at startup with an install hint.

### (b) Programmatic composition (no YAML)

Install `llm-agent-libs` + the peers you need. Construct `SmartAgent` via `SmartAgentBuilder` in code. Import provider classes from their packages and pass instances to the builder's fluent setters.

```bash
npm install @mcp-abap-adt/llm-agent-libs \
            @mcp-abap-adt/llm-agent-mcp \
            @mcp-abap-adt/llm-agent-rag \
            @mcp-abap-adt/deepseek-llm \
            @mcp-abap-adt/ollama-embedder
```

### (c) Core-only (no SmartAgent, no server)

```bash
npm install @mcp-abap-adt/llm-agent
```

Build your own agent against the interfaces exported by core. Supply your own `ILlm` and `IEmbedder` implementations.

Upgrading? The `coordinator:` block and the legacy
`pipeline: { mcp | rag | stages | llm }` overrides were removed in **v19** —
a config using them fails loud at startup with a migration message; see
[PIPELINES.md](docs/PIPELINES.md). From v10, see
[docs/MIGRATION-v11.md](docs/MIGRATION-v11.md).

## Documentation

- [QUICK_START.md](docs/QUICK_START.md) — end-to-end guide: install, config, connect IDE
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture reference: thin proxy layer + SmartAgent/SmartServer/pipeline
- [INTEGRATION.md](docs/INTEGRATION.md) — custom interface implementation guide with code examples
- [PIPELINES.md](docs/PIPELINES.md) — every built-in pipeline and its config dialect; writing your own pipeline plugin
- [EXAMPLES.md](docs/EXAMPLES.md) — YAML config examples and programmatic composition snippets
- [PERFORMANCE.md](docs/PERFORMANCE.md) — RAG, BM25, tool-selection strategy (`top-k`/`threshold`), model selection, token budget tuning
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — symptom → cause → fix index
- [CLIENT_SETUP.md](docs/CLIENT_SETUP.md) — connection instructions for Claude CLI, Cline, and Goose
- [SAP_AI_CORE.md](docs/SAP_AI_CORE.md) — SAP AI Core operational guidance and troubleshooting
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — production deployment patterns (Docker, systemd, serverless)

## Development

```bash
# Build project (tsc -b across all workspaces, in dependency order)
npm run build

# Unit tests — node:test via tsx, fanned out across every workspace
npm test

# Lint / format (Biome). `lint:check` is the gate; `lint` auto-fixes.
npm run lint:check
npm run lint

# Development with hot-reload (resolves workspace imports to dist/ — build first)
npm run dev

# Smart server production entrypoint (installed bin; from a checkout use
# `npm run start --workspace @mcp-abap-adt/llm-agent-server` after a build)
npx llm-agent

# Use specific example configs
npm run dev:ollama        # examples/docker-ollama (fully local, no API keys)
npm run dev:deepseek      # examples/docker-deepseek
npm run dev:sap-ai-core   # examples/docker-sap-ai-core
```

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — every package
in this monorepo. Earlier published versions (≤ v20.9.5) were MIT and stay MIT;
a licence change is not retroactive.

Copyright © 2025–2026 Oleksii Kyslytsia

This software is free software: you can redistribute it and/or modify it under
the terms of the GNU Lesser General Public License as published by the Free
Software Foundation, version 3.

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
PURPOSE. See the GNU Lesser General Public License for more details.

Both texts ship with every package and both are needed: [`LICENSE`](LICENSE) is
the LGPL, [`COPYING`](COPYING) is the GPL it is written on top of, since the LGPL
is a set of additional permissions over the GPL and cannot be read alone.

**What this means if you depend on these packages.** Linking them into your own
program — importing them, as every consumer of an npm package does, or running
`llm-agent` as a server your own code talks to over HTTP — does not put your
program under the LGPL. What the licence asks is that changes *to these
libraries* stay free, and that your users can replace them with their own build.

Domain skills you load at runtime through `skillPlugins:` are your content under
your licence: the engine never vendors them, so they are not a derivative work of
it.
