# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.1] — 2026-02-24

### Summary

Maintenance release focused on package identity alignment and release documentation.

### Changed

- npm package renamed to `@mcp-abap-adt/llm-agent` across docs, import examples, CLI help text,
  and MCP client metadata.
- Package metadata updated to reflect component-first positioning (Smart LLM-agent building blocks
  first, default server implementation second).
- Documentation set reorganized and expanded:
  - added beta testing plan and incremental streaming plan,
  - archived legacy architecture analysis/roadmap documents under `docs/archive/`.

---

## [1.0.0] — 2026-02-24

### Summary

First stable release. Introduces **SmartAgent** — a full multi-turn, RAG-driven, MCP-orchestrated
agent — and **SmartServer** — an OpenAI-compatible HTTP server that wraps it. The existing thin-proxy
CLI is retained unchanged as a dev/testing convenience.

### Added

#### SmartAgent core (phases 1–8)

- **Phase 1 — Contracts** (`ILlm`, `IRag`, `IMcpClient`, `ILogger`, `SmartAgentDeps`)
  — all interfaces fully typed; `Result<T>` used throughout for explicit error handling.
- **Phase 2 — Adapters** (`LlmAdapter`, `McpClientAdapter`)
  — bridges existing `BaseAgent` / `MCPClientWrapper` into the new contract interfaces.
- **Phase 3 — RAG implementations**
  — `InMemoryRag` (TF-IDF keyword similarity, zero deps) and `OllamaRag` (neural embeddings via
  Ollama `/api/embed`); configurable dedup threshold.
- **Phase 4 — Classifier** (`SubpromptClassifier`)
  — LLM-based intent classification; routes messages to the correct retrieval path.
- **Phase 5 — Context assembler** — token-budget-aware message window assembly.
- **Phase 6 — Orchestrator** (`SmartAgent`)
  — multi-turn tool loop with RAG-based tool preselection, cross-lingual query translation,
  configurable `maxIterations` / `maxToolCalls` guards.
- **Phase 7 — SmartServer** (`SmartServer`)
  — OpenAI-compatible HTTP server; exposes `/v1/chat/completions`, `/v1/models`, `/v1/usage`;
  supports streaming (`stream: true`) and non-streaming modes.
  Routing modes: `smart` | `passthrough` | `hybrid`.
- **Phase 8 — Observability** (`ConsoleLogger`, structured JSON log events)
  — `pipeline_start`, `classify`, `rag_query`, `rag_translate`, `tool_preselect`, `tool_call`,
  `pipeline_done`, `pipeline_error` event types; `DEBUG_SMART_AGENT=true` env var.

#### Security (phase 9)

- `ToolPolicyGuard` — allowlist/denylist policy enforcement per tool call.
- `HeuristicInjectionDetector` — prompt-injection heuristic guard on tool results.
- Both guards wired into `SmartAgent` and configurable via `SmartAgentDeps`.

#### SmartAgentBuilder

- Fluent builder API (`SmartAgentBuilder`) for programmatic wiring of all SmartAgent components.
- Sensible defaults: DeepSeek LLM, InMemoryRag for all stores, no MCP.
- Override methods: `.withMainLlm()`, `.withClassifierLlm()`, `.withRag()`, `.withMcpClients()`,
  `.withLogger()`, `.withPolicy()`.
- Multi-MCP support: `mcp` accepts a single config or an array; all servers are connected and
  tool-vectorized during `build()`.

#### YAML pipeline configuration

- `pipeline:` section in `smart-server.yaml` for advanced multi-component setups:
  - `pipeline.llm.main` / `pipeline.llm.classifier` — independent LLM providers per role
    (supports `deepseek`, `openai`, `anthropic`).
  - `pipeline.rag.facts` / `pipeline.rag.feedback` / `pipeline.rag.state` — per-store RAG backends.
  - `pipeline.mcp` — array of MCP server configs (HTTP or stdio).
- Backwards compatible: existing flat `llm:` / `rag:` / `mcp:` config works unchanged.
- When `pipeline.llm.main` is set, flat `llm.apiKey` is not required.

#### CLI (`llm-agent`)

- `llm-agent` binary (entry point: `dist/smart-agent/cli.js`).
- Auto-generates `smart-server.yaml` template and exits on first run (no config file found).
- All YAML settings overridable via CLI flags (`--port`, `--llm-api-key`, `--rag-type`, etc.).
- `--config`, `--env` flags for non-default file locations.

#### Developer experience

- `SmartAgentBuilder` exported for programmatic embedding (see `EXAMPLES.md` S7).
- `SmartServer` exported for programmatic embedding (see `EXAMPLES.md` S6).
- `testing` sub-path export for test utilities.
- `smart-server` sub-path export for direct SmartServer import.
- `release:check` npm script: lint + build + full test suite.

#### Documentation

- `QUICK_START.md` — end-to-end guide: install → config → connect IDE.
- `docs/ARCHITECTURE.md` — full architecture reference including SmartAgent internals, pipeline
  config, and programmatic API.
- `docs/BETA_TESTING_PLAN.md` — 11 manual verification scenarios (T1–T11).
- `docs/SECURITY_THREAT_MODEL.md` — threat model for the agent layer.
- `EXAMPLES.md` — 7 SmartServer usage examples (S1–S7).
- `docs/INCREMENTAL_STREAMING_PLAN.md` — open research questions and design sketch for true
  incremental streaming (next iteration).

### Changed

- `ragQueryK` default: 5 → 10.
- `SmartAgentBuilderConfig.mcp` now accepts `BuilderMcpConfig | BuilderMcpConfig[]`.

### Deprecated

- Thin-proxy CLI (`npm run dev`, `npm run dev:llm`) — retained for dev/testing; no planned removal.

---

## [0.0.1] — initial

Initial scaffolding: thin LLM proxy, BaseAgent template, OpenAI / Anthropic / DeepSeek provider
adapters, MCPClientWrapper multi-transport abstraction.
