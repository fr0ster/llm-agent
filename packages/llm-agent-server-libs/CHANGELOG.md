# @mcp-abap-adt/llm-agent-server-libs

## 18.1.1

### Patch Changes

- Version alignment — unify ALL workspace packages to a single version.

  18.1.0 bumped only the six core packages (the changeset `fixed` group at the time), leaving the eleven provider / embedder / RAG-backend packages at 18.0.2. The `fixed` group now contains all 17 packages so every release moves them together. This release carries no functional change — it only realigns the provider/embedder/backend packages (18.0.2 → 18.1.1) and the core packages (18.1.0 → 18.1.1) to one version.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.1
  - @mcp-abap-adt/llm-agent-mcp@18.1.1
  - @mcp-abap-adt/llm-agent-rag@18.1.1
  - @mcp-abap-adt/llm-agent-libs@18.1.1
  - @mcp-abap-adt/sap-aicore-llm@18.1.1

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
  - @mcp-abap-adt/llm-agent-mcp@18.1.0
  - @mcp-abap-adt/llm-agent-rag@18.1.0
