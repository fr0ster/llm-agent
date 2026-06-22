# @mcp-abap-adt/llm-agent-libs

## 19.3.0

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

- Fix: `usage.models` now keys by the LIVE (hot-swapped) model, not the stale initial one (#164).

  `SmartAgent.reconfigure()` swapped its own `_mainLlm` but the `DefaultPipeline` held a separate `deps.mainLlm` snapshot, so a hot-swapped request kept logging — and aggregating `usage.models` under — the initial model name. `reconfigure()` now propagates the swap into the pipeline. Also lands an env-gated `node:test` integration check that the DAG coordinator dispatches real MCP-tool work to its worker (regression gate for the toolless/hallucination path, #159), and the reviewed design spec + implementation plan for client-provided external tools under the DAG coordinator (#171).

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.2
  - @mcp-abap-adt/llm-agent-mcp@18.1.2
  - @mcp-abap-adt/llm-agent-rag@18.1.2
  - @mcp-abap-adt/openai-llm@18.1.2
  - @mcp-abap-adt/anthropic-llm@18.1.2
  - @mcp-abap-adt/deepseek-llm@18.1.2
  - @mcp-abap-adt/sap-aicore-llm@18.1.2
  - @mcp-abap-adt/ollama-llm@18.1.2

## 18.1.1

### Patch Changes

- Version alignment — unify ALL workspace packages to a single version.

  18.1.0 bumped only the six core packages (the changeset `fixed` group at the time), leaving the eleven provider / embedder / RAG-backend packages at 18.0.2. The `fixed` group now contains all 17 packages so every release moves them together. This release carries no functional change — it only realigns the provider/embedder/backend packages (18.0.2 → 18.1.1) and the core packages (18.1.0 → 18.1.1) to one version.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.1
  - @mcp-abap-adt/llm-agent-mcp@18.1.1
  - @mcp-abap-adt/llm-agent-rag@18.1.1
  - @mcp-abap-adt/openai-llm@18.1.1
  - @mcp-abap-adt/anthropic-llm@18.1.1
  - @mcp-abap-adt/deepseek-llm@18.1.1
  - @mcp-abap-adt/sap-aicore-llm@18.1.1
  - @mcp-abap-adt/ollama-llm@18.1.1

## 18.1.0

### Minor Changes

- 18.1 — Evaluator spine, hallucination guards, and the SmartServer composition library.

  - **Evaluator (per-level input judge):** the Stepper coordinator now runs an LLM Evaluator before planning that routes a step `executable | needs-work | needs-consumer` with a `missing[]` list, on by default at all depths; recursion requires it as a terminator. The `missing` gaps drive an additive, single-intent tool search (prompt-search ∪ needs-search) so a "review the program" prompt surfaces `GetProgram` while the needs surface `GetInclude`/`GetIncludesList`.
  - **Hallucination guards (Stepper executor):** an explicit no-capability error — when the Evaluator established a need but the toolset is empty after all seeding, the executor throws a clarify signal instead of fabricating an answer (`allowToolless` to opt out); and a token-grounding detector — a final answer produced with no tool calls, no grounding facts, and tools on offer is flagged (`hallucination_suspected`) with token evidence.
  - **New package `@mcp-abap-adt/llm-agent-server-libs`:** the SmartServer composition runtime is now an importable library (between the binary and core `llm-agent-libs`). It carries `SmartServer`, `buildFromComposition`/`buildStepperRoot`, `StepperCoordinatorHandler`, coordinator config parsing, session stores, and the **pipeline builder-factories** `LinearFactory`, `DagFactory`, `CyclicFactory`, `PlannedFactory`, `DeepStepperFactory` (each builds one pipeline's `coordinator` stage handler from a typed config + role-resolving deps). `buildFromComposition` accepts a `makeRoleLlm` callback so factories work without the server's config types. `@mcp-abap-adt/llm-agent-server` is now a thin binary that depends on it (behaviour unchanged).
  - **Clean plain-mode content:** tool-loop liveness markers (`[SmartAgent: Executing X]`) are now flagged `ephemeral` and excluded from non-streaming content accumulation, so `stream:false` responses (including DAG) no longer leak execution traces into the final answer. Streaming clients still receive them as liveness. The pipeline builder-factories also gained `build()` smoke coverage for all five plus an `execute()` integration test.

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.0
  - @mcp-abap-adt/llm-agent-mcp@18.1.0
  - @mcp-abap-adt/llm-agent-rag@18.1.0

## 12.0.3

### Patch Changes

- 108cd1d: Complete the v12 package split: introduce `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, and `@mcp-abap-adt/llm-agent-libs`. `@mcp-abap-adt/llm-agent-server` becomes binary-only — composition surface lives in `llm-agent-libs`, MCP in `llm-agent-mcp`, RAG/embedder in `llm-agent-rag`, interfaces and DTOs in `llm-agent`. Top-level `makeLlm` / `makeDefaultLlm` / `makeRag` are now async (`Promise<...>`); `resolveEmbedder` remains synchronous and uses the existing prefetch contract. `SmartAgentBuilder.build()` was already async — consumers using only the builder are unaffected. Closes #125.
- Updated dependencies [108cd1d]
  - @mcp-abap-adt/llm-agent@12.0.1
  - @mcp-abap-adt/llm-agent-mcp@12.0.1
  - @mcp-abap-adt/llm-agent-rag@12.0.1
