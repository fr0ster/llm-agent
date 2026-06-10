# @mcp-abap-adt/llm-agent-server

## 19.1.2

Release 19.1.2.

## 19.1.1

Release 19.1.1.

## 19.1.0

Release 19.1.0.

## 19.0.0

### ⚠ BREAKING CHANGES

- **Pipeline selection is now plugin-based.** The old top-level `coordinator:` YAML block and the legacy `pipeline: { mcp | rag | stages | llm }` overrides are **removed**. Select a pipeline with `pipeline: { name, config }` where `name` is `flat` | `linear` | `dag` | `stepper` | a custom plugin name. A config still using the old form **fails loud** at startup with a migration message. Top-level `llm:`, `mcp:`, `rag:`, `subagents:` are unchanged.
  - **Migration:** `coordinator: { mode: planned-react, knowledgeSeed: [...] }` → `pipeline: { name: stepper, config: { mode: planned-react, knowledgeSeed: [...] } }`; DAG (`planner`/`reviewer`/`finalizer`) → `pipeline: { name: dag, config: {...} }`; linear (`planning`/`dispatch`/`activation`) → `pipeline: { name: linear, config: {...} }`. `knowledgeSeed` now lives under `pipeline.config`. Pin a version `<= 18` for the old behavior.

### Added

- **Pipeline plugins.** A pipeline is an `IPipelinePlugin` (core `@mcp-abap-adt/llm-agent`) that builds an `IPipelineInstance` (`{ agent, close }`). Built-in `flat`/`linear`/`dag`/`stepper` wrap the existing coordinator components. Custom pipelines load dynamically via `plugins: [<module-specifier>]` (resolved against the user's cwd; a module's full `PluginExports` — incl. `embedderFactories`/`mcpClients` — is merged before RAG). Duplicate pipeline names across sources fail fast.
- **Subpath exports** from `@mcp-abap-adt/llm-agent-server-libs`: `./flat` `./linear` `./dag` `./stepper` (built-in plugins) and `./legacy/<flow>` (the pre-v19 coordinator components, for code-level composition without YAML). `IServerPipelineContext` + `createServerPipelineContext` are exported for plugin authors.

### Changed

- The per-session request-serving agent is built by the resolved pipeline plugin; the startup global agent remains the infra/passthrough handle. The plugin contract (`IPipelineInstance = { agent, close }`) stays core-clean — server concerns live in `IServerPipelineContext`.

### Fixed

- **MCP wiring.** A YAML `mcp:` block now connects **exactly once** (the prior path double-connected). `toolsRag.lookup()` resolves **synchronously before any query** (catalog eager-loaded at startup). MCP **tool-vectorization is preserved** for the YAML path (so `smart`/`flat` pipelines still surface MCP tools to the model). An explicit `mcpClients: []` **disables MCP** and overrides a YAML `mcp:` block (DI precedence).

## 18.2.0

Client-provided external tools under the DAG coordinator (#171). External (client) tools are now mode-independent (always offered; `hard` governs only internal MCP execution), consumer-executed (the worker surfaces a standard tool_call via the normal OpenAI/Anthropic round-trip — no custom transport), and carry deterministic content-addressed `ext:` ids for stateless re-run correlation. Parallel DAG workers' external calls are collected into one terminal assistant turn; incoming external results are adjacency-validated and the consumed turns stripped from internal LLM message lists.

## 18.1.2

### Patch Changes

- Fix: `usage.models` now keys by the LIVE (hot-swapped) model, not the stale initial one (#164).

  `SmartAgent.reconfigure()` swapped its own `_mainLlm` but the `DefaultPipeline` held a separate `deps.mainLlm` snapshot, so a hot-swapped request kept logging — and aggregating `usage.models` under — the initial model name. `reconfigure()` now propagates the swap into the pipeline. Also lands an env-gated `node:test` integration check that the DAG coordinator dispatches real MCP-tool work to its worker (regression gate for the toolless/hallucination path, #159), and the reviewed design spec + implementation plan for client-provided external tools under the DAG coordinator (#171).

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.2
  - @mcp-abap-adt/llm-agent-libs@18.1.2
  - @mcp-abap-adt/llm-agent-server-libs@18.1.2
  - @mcp-abap-adt/llm-agent-mcp@18.1.2
  - @mcp-abap-adt/llm-agent-rag@18.1.2
  - @mcp-abap-adt/openai-llm@18.1.2
  - @mcp-abap-adt/anthropic-llm@18.1.2
  - @mcp-abap-adt/deepseek-llm@18.1.2
  - @mcp-abap-adt/sap-aicore-llm@18.1.2
  - @mcp-abap-adt/ollama-llm@18.1.2
  - @mcp-abap-adt/openai-embedder@18.1.2
  - @mcp-abap-adt/ollama-embedder@18.1.2
  - @mcp-abap-adt/sap-aicore-embedder@18.1.2
  - @mcp-abap-adt/qdrant-rag@18.1.2
  - @mcp-abap-adt/hana-vector-rag@18.1.2
  - @mcp-abap-adt/pg-vector-rag@18.1.2

## 18.1.1

### Patch Changes

- Version alignment — unify ALL workspace packages to a single version.

  18.1.0 bumped only the six core packages (the changeset `fixed` group at the time), leaving the eleven provider / embedder / RAG-backend packages at 18.0.2. The `fixed` group now contains all 17 packages so every release moves them together. This release carries no functional change — it only realigns the provider/embedder/backend packages (18.0.2 → 18.1.1) and the core packages (18.1.0 → 18.1.1) to one version.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.1
  - @mcp-abap-adt/llm-agent-mcp@18.1.1
  - @mcp-abap-adt/llm-agent-rag@18.1.1
  - @mcp-abap-adt/llm-agent-libs@18.1.1
  - @mcp-abap-adt/llm-agent-server-libs@18.1.1
  - @mcp-abap-adt/openai-llm@18.1.1
  - @mcp-abap-adt/anthropic-llm@18.1.1
  - @mcp-abap-adt/deepseek-llm@18.1.1
  - @mcp-abap-adt/sap-aicore-llm@18.1.1
  - @mcp-abap-adt/ollama-llm@18.1.1
  - @mcp-abap-adt/openai-embedder@18.1.1
  - @mcp-abap-adt/ollama-embedder@18.1.1
  - @mcp-abap-adt/sap-aicore-embedder@18.1.1
  - @mcp-abap-adt/qdrant-rag@18.1.1
  - @mcp-abap-adt/hana-vector-rag@18.1.1
  - @mcp-abap-adt/pg-vector-rag@18.1.1

## 18.1.0

### Minor Changes

- 18.1 — Evaluator spine, hallucination guards, and the SmartServer composition library.

  - **Evaluator (per-level input judge):** the Stepper coordinator now runs an LLM Evaluator before planning that routes a step `executable | needs-work | needs-consumer` with a `missing[]` list, on by default at all depths; recursion requires it as a terminator. The `missing` gaps drive an additive, single-intent tool search (prompt-search ∪ needs-search) so a "review the program" prompt surfaces `GetProgram` while the needs surface `GetInclude`/`GetIncludesList`.
  - **Hallucination guards (Stepper executor):** an explicit no-capability error — when the Evaluator established a need but the toolset is empty after all seeding, the executor throws a clarify signal instead of fabricating an answer (`allowToolless` to opt out); and a token-grounding detector — a final answer produced with no tool calls, no grounding facts, and tools on offer is flagged (`hallucination_suspected`) with token evidence.
  - **New package `@mcp-abap-adt/llm-agent-server-libs`:** the SmartServer composition runtime is now an importable library (between the binary and core `llm-agent-libs`). It carries `SmartServer`, `buildFromComposition`/`buildStepperRoot`, `StepperCoordinatorHandler`, coordinator config parsing, session stores, and the **pipeline builder-factories** `LinearFactory`, `DagFactory`, `CyclicFactory`, `PlannedFactory`, `DeepStepperFactory` (each builds one pipeline's `coordinator` stage handler from a typed config + role-resolving deps). `buildFromComposition` accepts a `makeRoleLlm` callback so factories work without the server's config types. `@mcp-abap-adt/llm-agent-server` is now a thin binary that depends on it (behaviour unchanged).

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.0
  - @mcp-abap-adt/llm-agent-libs@18.1.0
  - @mcp-abap-adt/llm-agent-server-libs@18.1.0
  - @mcp-abap-adt/llm-agent-mcp@18.1.0
  - @mcp-abap-adt/llm-agent-rag@18.1.0

## 12.0.3

### Patch Changes

- 108cd1d: Complete the v12 package split: introduce `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, and `@mcp-abap-adt/llm-agent-libs`. `@mcp-abap-adt/llm-agent-server` becomes binary-only — composition surface lives in `llm-agent-libs`, MCP in `llm-agent-mcp`, RAG/embedder in `llm-agent-rag`, interfaces and DTOs in `llm-agent`. Top-level `makeLlm` / `makeDefaultLlm` / `makeRag` are now async (`Promise<...>`); `resolveEmbedder` remains synchronous and uses the existing prefetch contract. `SmartAgentBuilder.build()` was already async — consumers using only the builder are unaffected. Closes #125.
- Updated dependencies [108cd1d]
  - @mcp-abap-adt/llm-agent@12.0.1
  - @mcp-abap-adt/llm-agent-mcp@12.0.1
  - @mcp-abap-adt/llm-agent-rag@12.0.1
  - @mcp-abap-adt/llm-agent-libs@12.0.1

## 12.0.0

### Major Changes

- Move library helpers from `@mcp-abap-adt/llm-agent-server` into `@mcp-abap-adt/llm-agent` (#123).

  **BREAKING CHANGE.** Embedded consumers that ship their own HTTP server can now depend on `@mcp-abap-adt/llm-agent` only and skip the server package entirely. The following symbols are no longer exported from `@mcp-abap-adt/llm-agent-server` — import them from `@mcp-abap-adt/llm-agent` instead:

  - **Resilience:** `CircuitBreaker`, `CircuitBreakerConfig`, `CircuitState`, `CircuitBreakerLlm`, `CircuitBreakerEmbedder`, `FallbackRag`
  - **LLM call policies:** `NonStreamingLlmCallStrategy`, `StreamingLlmCallStrategy`, `FallbackLlmCallStrategy`
  - **Tool cache:** `ToolCache`, `NoopToolCache`, `IToolCache`
  - **API adapters:** `AnthropicApiAdapter`, `OpenAiApiAdapter`, `AdapterValidationError`, `ApiRequestContext`, `ApiSseEvent`, `ILlmApiAdapter`, `NormalizedRequest`
  - **Client adapters:** `ClineClientAdapter`, `IClientAdapter`
  - **Tool utilities:** `normalizeAndValidateExternalTools`, `normalizeExternalTools`, `ExternalToolValidationCode`, `ExternalToolValidationError`, `CLIENT_PROVIDED_PREFIX`, `getStreamToolCallName`, `toToolCallDelta`
  - **Logger:** `ILogger`, `LogEvent`

  `@mcp-abap-adt/llm-agent` runtime dependencies remain unchanged (`zod` only). The runnable distribution (`SmartAgentBuilder`, `SmartServer`, providers/factories composition root, plugins, skills, sessions, metrics, tracer, validator, reranker, history, structured pipeline, health, config watcher, MCP client wrapper, CLI, bin entries) stays in `@mcp-abap-adt/llm-agent-server`.

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0
  - @mcp-abap-adt/anthropic-llm@12.0.0
  - @mcp-abap-adt/deepseek-llm@12.0.0
  - @mcp-abap-adt/hana-vector-rag@12.0.0
  - @mcp-abap-adt/ollama-embedder@12.0.0
  - @mcp-abap-adt/openai-embedder@12.0.0
  - @mcp-abap-adt/openai-llm@12.0.0
  - @mcp-abap-adt/pg-vector-rag@12.0.0
  - @mcp-abap-adt/qdrant-rag@12.0.0
  - @mcp-abap-adt/sap-aicore-embedder@12.0.0
  - @mcp-abap-adt/sap-aicore-llm@12.0.0

## 11.1.2

### Patch Changes

- Bump dependencies: biome 2.4.13, typescript 6.0.3, @types/node 25, rimraf 6, zod 4.3. MCP SDK 1.29 supports zod 3 || 4; smoke-tested via `npm run dev` against real MCP server.
- Updated dependencies
  - @mcp-abap-adt/llm-agent@11.1.2
  - @mcp-abap-adt/openai-llm@11.1.2
  - @mcp-abap-adt/anthropic-llm@11.1.2
  - @mcp-abap-adt/deepseek-llm@11.1.2
  - @mcp-abap-adt/sap-aicore-llm@11.1.2
  - @mcp-abap-adt/openai-embedder@11.1.2
  - @mcp-abap-adt/ollama-embedder@11.1.2
  - @mcp-abap-adt/sap-aicore-embedder@11.1.2
  - @mcp-abap-adt/qdrant-rag@11.1.2
  - @mcp-abap-adt/hana-vector-rag@11.1.2
  - @mcp-abap-adt/pg-vector-rag@11.1.2

## 11.1.1

### Patch Changes

- Fix streaming `tool_calls` regression introduced in the 10.x provider split (#119) and surface MCP setup failures that were previously swallowed (#118).

  - **Streaming providers now emit normalized `toolCalls` deltas.** `sap-aicore-llm` reads `chunk.getDeltaToolCalls()`, `openai-llm` (and `deepseek-llm` by inheritance) reads `choice.delta.tool_calls`, and `anthropic-llm` tracks `tool_use` content blocks plus `input_json_delta` — populating the new optional `LLMResponse.toolCalls` field. `LlmProviderBridge` accumulates from this normalized field instead of digging into provider-specific `raw` payloads (it previously handled only the OpenAI shape, so SAP and Anthropic streaming tool calls were dropped). Anthropic also normalizes `stop_reason: 'tool_use'` → `finishReason: 'tool_calls'`.
  - **`SmartAgentBuilder.build()` no longer swallows MCP setup errors.** Connect failures (unreachable host, bad auth, container-network mismatch) and post-connect failures (tool vectorization throwing) now produce a `warning` log entry — `MCP setup failed for <url-or-command>: <error message>` — instead of disappearing into a bare `catch {}`. Graceful-degradation contract preserved.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@11.1.1
  - @mcp-abap-adt/openai-llm@11.1.1
  - @mcp-abap-adt/anthropic-llm@11.1.1
  - @mcp-abap-adt/deepseek-llm@11.1.1
  - @mcp-abap-adt/sap-aicore-llm@11.1.1
  - @mcp-abap-adt/openai-embedder@11.1.1
  - @mcp-abap-adt/ollama-embedder@11.1.1
  - @mcp-abap-adt/sap-aicore-embedder@11.1.1
  - @mcp-abap-adt/qdrant-rag@11.1.1
  - @mcp-abap-adt/hana-vector-rag@11.1.1
  - @mcp-abap-adt/pg-vector-rag@11.1.1

## 11.1.0

### Minor Changes

- feat: forward `scenario` and `resourceGroup` from RAG store config to the SAP AI Core embedder, so consumers can target `scenario: 'foundation-models'` deployments via YAML/programmatic config (see #116).

## 11.0.0

### Major Changes

- Complete provider and backend extraction. Eight new packages shipped:
  @mcp-abap-adt/openai-llm, anthropic-llm, deepseek-llm, sap-aicore-llm,
  openai-embedder, ollama-embedder, sap-aicore-embedder, qdrant-rag.

  Breaking changes:

  - Back-compat re-exports from v10.0 removed. Each symbol lives in exactly
    one package. See docs/MIGRATION-v11.md for the symbol-by-symbol table.
  - Non-Smart Agent hierarchy removed. Use SmartAgent + a provider class
    directly.
  - Core runtime dep shrinks to zod only; axios and @sap-ai-sdk/\* move to
    their respective extracted packages.
  - Server provider dependencies are optional peer deps. Install only the
    peers your smart-server.yaml names. Missing peer throws
    MissingProviderError at startup.

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0
  - @mcp-abap-adt/openai-llm@12.0.0
  - @mcp-abap-adt/anthropic-llm@12.0.0
  - @mcp-abap-adt/deepseek-llm@12.0.0
  - @mcp-abap-adt/sap-aicore-llm@12.0.0
  - @mcp-abap-adt/openai-embedder@12.0.0
  - @mcp-abap-adt/ollama-embedder@12.0.0
  - @mcp-abap-adt/sap-aicore-embedder@12.0.0
  - @mcp-abap-adt/qdrant-rag@12.0.0

## 10.0.0

### Major Changes

- Split single package into a monorepo with two initial packages:

  - `@mcp-abap-adt/llm-agent` — interfaces, types, and lightweight RAG default implementations.
  - `@mcp-abap-adt/llm-agent-server` — default SmartAgent, pipeline, LLM providers, MCP client, HTTP server, and CLIs.

  Consumers of the v9 single package must switch their imports to one or both v10 packages. See `docs/MIGRATION-v10.md` for the symbol-by-symbol mapping and install-command changes.

  CLI bins (`llm-agent`, `llm-agent-check`, `claude-via-agent`) remain available and are now shipped by `@mcp-abap-adt/llm-agent-server`.

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@10.0.0
