# @mcp-abap-adt/ollama-embedder

## 20.1.0

### Added

- **MCP readiness & fail-loud** (#201–#205): a first-class readiness surface for
  MCP-backed servers. `/health` now returns **503** while MCP is not ready; a
  pre-dispatch request gate rejects work that needs an unavailable MCP; and every
  execution surface **fails loud** instead of returning a silent `(no response)`.
  Built ON the MCP connection strategies (+ a small `IReadinessReporter`), with
  error classification and session-preserving reconnect; the builder now defaults
  MCP to a connection strategy with agent readiness.

### Changed

- **Behavior:** requests and health checks now surface MCP-unavailability errors
  loudly (503 / typed error) where prior versions could return an empty/degraded
  response. No published config key or API was removed — a config that loaded
  before still loads and runs; only genuine MCP-down conditions now error clearly.
- **Internal decomposition (monolith audit, #206; PRs #208–#218) — public API
  byte-stable, behavior-preserving.** The largest runtime files were decomposed
  into focused, individually-testable modules (all moves byte-for-byte, verified
  against characterization tests + whole-branch review):
  - `smart-server.ts` 3926 → 2559 (7 components + full HTTP handler extraction +
    `makeToolsRagHandle` factory).
  - `agent.ts` 2160 → 1302 and the shared tool-execution core deduped into
    `pipeline/handlers/tool-loop-core.ts`.
  - `config.ts` 1648 → 269 (5 modules + a thin `resolveSmartServerConfig`
    delegating per-section builders).
  - `controller-coordinator-handler.ts` 2026 → 1682 (parser/recall/usage-logging
    siblings) and an inverted dependency fixed (`planner`/`reviewer` no longer
    import from the handler).
  - `builder.ts` 1437 → 1182, extracting MCP **tool vectorization** into
    `mcp/vectorize-mcp-tools.ts` — closing the `docs/ARCHITECTURE.md` tech-debt.
  These changes are internal only; every public export path is unchanged.

## 20.0.0

### Added
- Controller planner capability-tuned planners (§C): smart-executor (default `controller`) and weak-executor (new `controller-weak` preset); preset-encoded selection; `ControllerFactory.build(config, deps, kind)` + `deps.controllerPlanner` DI seam.
### Changed
- `controller` defaults to the live digest board (smart-executor; was incremental).
### Removed
- `planner:` controller config key + `IncrementalPlanner` (clean break, fail-loud — no alias).
### Fixed / Docs
- v19 documentation-accuracy pass: migrated ~25 example configs + docs off removed shapes (`coordinator:`, structured `pipeline:{version,stages}`, `withStageHandler`) to the current `pipeline:{name,config}` model; all shipped examples config-validate.

## 19.2.0

### Added
- Controller planner — step identity & live digest board (Phase 1+2): stable per-step
  `stepId`, `plan-decision` artifacts, reviewer planning `digest` (`ReviewOutcome`),
  `stepId`+`digest` on every step-result (incl. control failures), bounded
  `renderBoard` with a guaranteed cap (fail-loud), additive board+plannerPrivate
  prompt, canonical writeOrdinal replay (no phantom planned orphans).
- Skill plugin-host & runtime gnostification (`skillPlugins:`): domain-agnostic host
  materialising consumer skills into a grouped skills-RAG; marketplace + inline
  sources; controller + assembler recall.
- Controller execution-result control & data backbone: reviewer/finalizer split,
  durable run-scope + crash recovery, run-scoped embedding recall.

### Fixed
- Results-RAG: bound embed input (`maxEmbedChars`, default 16000) for large tool/step
  results so an over-limit document no longer 400s the embedder and stalls the run;
  stored content stays full.

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

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.2

## 18.1.1

### Patch Changes

- Version alignment — unify ALL workspace packages to a single version.

  18.1.0 bumped only the six core packages (the changeset `fixed` group at the time), leaving the eleven provider / embedder / RAG-backend packages at 18.0.2. The `fixed` group now contains all 17 packages so every release moves them together. This release carries no functional change — it only realigns the provider/embedder/backend packages (18.0.2 → 18.1.1) and the core packages (18.1.0 → 18.1.1) to one version.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.1

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

## 11.1.2

### Patch Changes

- Bump dependencies: biome 2.4.13, typescript 6.0.3, @types/node 25, rimraf 6, zod 4.3. MCP SDK 1.29 supports zod 3 || 4; smoke-tested via `npm run dev` against real MCP server.
- Updated dependencies
  - @mcp-abap-adt/llm-agent@11.1.2

## 11.1.1

### Patch Changes

- Fix streaming `tool_calls` regression introduced in the 10.x provider split (#119) and surface MCP setup failures that were previously swallowed (#118).

  - **Streaming providers now emit normalized `toolCalls` deltas.** `sap-aicore-llm` reads `chunk.getDeltaToolCalls()`, `openai-llm` (and `deepseek-llm` by inheritance) reads `choice.delta.tool_calls`, and `anthropic-llm` tracks `tool_use` content blocks plus `input_json_delta` — populating the new optional `LLMResponse.toolCalls` field. `LlmProviderBridge` accumulates from this normalized field instead of digging into provider-specific `raw` payloads (it previously handled only the OpenAI shape, so SAP and Anthropic streaming tool calls were dropped). Anthropic also normalizes `stop_reason: 'tool_use'` → `finishReason: 'tool_calls'`.
  - **`SmartAgentBuilder.build()` no longer swallows MCP setup errors.** Connect failures (unreachable host, bad auth, container-network mismatch) and post-connect failures (tool vectorization throwing) now produce a `warning` log entry — `MCP setup failed for <url-or-command>: <error message>` — instead of disappearing into a bare `catch {}`. Graceful-degradation contract preserved.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@11.1.1

## 11.1.0

### Patch Changes

- Released alongside the @mcp-abap-adt/sap-aicore-embedder + @mcp-abap-adt/llm-agent-server foundation-models scenario fix (#116, #117) and the @mcp-abap-adt/qdrant-rag dimension mismatch guard. No source changes in this package — version sync per the changesets fixed group.

## 11.0.0

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0
