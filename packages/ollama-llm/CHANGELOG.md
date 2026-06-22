# @mcp-abap-adt/ollama-llm

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
  - @mcp-abap-adt/openai-llm@18.1.2

## 18.1.1

### Patch Changes

- Version alignment — unify ALL workspace packages to a single version.

  18.1.0 bumped only the six core packages (the changeset `fixed` group at the time), leaving the eleven provider / embedder / RAG-backend packages at 18.0.2. The `fixed` group now contains all 17 packages so every release moves them together. This release carries no functional change — it only realigns the provider/embedder/backend packages (18.0.2 → 18.1.1) and the core packages (18.1.0 → 18.1.1) to one version.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.1
  - @mcp-abap-adt/openai-llm@18.1.1

## 14.0.0

### Major Changes

- Initial release of the Ollama LLM provider.

  Implements `ILlm` by extending `OpenAIProvider` — Ollama exposes an OpenAI-compatible `/v1` API, so no custom HTTP layer is needed. Key behaviours:

  - Default `baseURL` is `http://localhost:11434/v1`; override via `OllamaConfig.baseURL`.
  - `apiKey` defaults to `'ollama'` (Ollama ignores it, but the underlying OpenAI client requires a non-empty value).
  - `getEmbeddingModels()` always returns `[]` — Ollama embedding models are addressed via separate provider packages.
  - `getTokenLimitParam` always returns `max_tokens` (no model-family branching needed).

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@14.0.0
  - @mcp-abap-adt/openai-llm@14.0.0
