# Pluggable tool-selection strategy + domain-neutral tool exposure (#135)

> **Status:** Design, approved. Closes [#135](https://github.com/fr0ster/llm-agent/issues/135).
>
> **Release target:** next minor (15.x line continues from 16.0.0 → 16.1.0, feature). Own PR.

## Problem

Tool exposure to the LLM should be driven by **semantic distance** between the user prompt and the tool catalogue (RAG over the `tools` store), not by domain-specific rules baked into the classifier prompt. Today the example classifier prompts carry SAP-specific routing rules ("only `action` if SAP terms present", "knowledge questions MUST be `action`…") so that SAP queries route to tools. That does not scale — every domain would need its own hand-written classifier rules.

Investigation of the current code (v16.0.0):

- `ToolSelectHandler` (`packages/llm-agent-libs/src/pipeline/handlers/tool-select.ts`) already runs unconditionally and **self-heals**: if RAG retrieval produced no results it queries the stores itself using `ctx.inputText` (lines 50-91). So tools are discoverable regardless of classification.
- It selects tools by taking **every** RAG result whose id has the `tool:` prefix from the top-K matches (lines 94-99) — **there is no score threshold**. So for an off-topic chat query the K nearest tools are still surfaced (noise), and there is no distance-based "no tools needed" signal.

So #135 splits into two concrete changes:

1. **Make the RAG-result → tool selection a pluggable `IToolSelectionStrategy`** with a score-threshold implementation, selectable via YAML or the builder. The threshold is what lets pure semantic distance decide *both* which tools and *whether any* tools — no classifier, no domain rules.
2. **Remove the SAP-specific routing rules from the example classifier prompts** and confirm the canonical query still reaches the tool — proving tool exposure is domain-neutral (semantic-distance-driven), not classifier-gated.

Default behavior is unchanged (top-K, no threshold) unless a deployment opts into the threshold strategy.

## Design

### 1. `IToolSelectionStrategy` (new interface)

A strategy that filters scored RAG results down to the subset considered relevant for tool exposure. It operates purely on scored results — it does NOT know about `tool:`/`skill:` prefixes, modes, or availability (those stay in the handler). This keeps it a small, independently testable unit.

Location: `packages/llm-agent/src/interfaces/tool-selection-strategy.ts` (contracts package, alongside other `I*` strategy interfaces). Re-exported from the package index.

```ts
import type { RagResult } from './rag.js';

/**
 * Decides which scored RAG results are relevant enough to drive tool exposure.
 * Input: the RAG results gathered for tool discovery (already top-K from the
 * store query, each carrying a `score`). Output: the subset to keep.
 * The handler then extracts `tool:`-prefixed ids from the kept results.
 */
export interface IToolSelectionStrategy {
  readonly name: string;
  select(results: RagResult[]): RagResult[];
}
```

### 2. Built-in strategies

Location: `packages/llm-agent-libs/src/pipeline/tool-selection/` (small files, one per strategy).

- **`TopKToolSelection`** (default) — passthrough: returns all results unchanged. Reproduces today's behavior exactly (the K cap is already applied at query time). `name = 'top-k'`.
- **`ScoreThresholdToolSelection`** — keeps results with `score >= minScore`. `name = 'threshold'`. Constructor: `new ScoreThresholdToolSelection(minScore: number)`. A query whose nearest tools are all below `minScore` yields an empty set → no tools surfaced → the LLM answers as plain chat. No classifier or domain rules involved.

`minScore` is embedder-dependent (bge-m3 cosine scores differ from nomic). The threshold value is the deployment's responsibility (documented), not hardcoded.

### 3. `tool-select.ts` integration

Replace the inline `tool:`-extraction (current lines 94-99) so the strategy filters `allRagResults` first:

```ts
const strategy = ctx.toolSelectionStrategy; // defaults to TopKToolSelection
const relevant = strategy.select(allRagResults);
const ragToolNames = new Set(
  relevant
    .map((r) => r.metadata.id as string)
    .filter((id) => id?.startsWith('tool:'))
    .map((id) => id.slice(5).replace(/:.*$/, '')),
);
```

Everything else in the handler (mode `hard` fallback to all tools, external tools, availability filtering, logging) is unchanged. Add the strategy name + kept/dropped counts to the `tools_selected` log step for diagnosability.

`ctx.toolSelectionStrategy` is a new optional field on `PipelineContext`, populated by the builder; when absent the handler uses a module-level `TopKToolSelection` singleton (so the contract has no hard dependency on wiring).

### 4. Selection via YAML or builder (mirrors coordinator strategies)

- **Builder DI:** `SmartAgentBuilder.withToolSelectionStrategy(strategy: IToolSelectionStrategy)`. Stored on the builder, threaded into `PipelineContext.toolSelectionStrategy` at build time. DI wins over YAML.
- **YAML:** `agent.toolSelection` block, resolved by a new `resolveToolSelectionStrategy(name, params)` factory in `packages/llm-agent-server/src/smart-agent/config.ts` (mirror of `resolveCoordinatorPlanning`):
  ```yaml
  agent:
    toolSelection:
      strategy: threshold      # top-k (default) | threshold
      minScore: 0.35           # required when strategy: threshold
  ```
  `resolveToolSelectionStrategy('top-k')` → `TopKToolSelection`; `resolveToolSelectionStrategy('threshold', { minScore })` → `ScoreThresholdToolSelection(minScore)`; unknown name → fail-loud `Error` listing valid names (consistent with #134 validation philosophy). `threshold` without `minScore` → clear error.
- `SmartServer` resolves the YAML strategy (when no DI strategy is injected) and passes it to the builder via `withToolSelectionStrategy`.
- Default when neither is set: `top-k` (no behavior change).

### 5. Domain-neutral classifier prompts

The classifier keeps its role (multi-step splitting, structural intent) but no longer needs domain rules to make tools reach the LLM — tool exposure is now the strategy-over-RAG path, which is independent of the `action`/`chat` typing.

- Remove the SAP-specific routing rules from the example classifier prompts: `examples/sap-ai-core-direct/smart-server.yaml`, `examples/docker-sap-ai-core/smart-server.yaml`, and any other example whose `prompts.classifier` encodes SAP/domain routing. Replace with the default domain-neutral classifier prompt (or drop the override so the built-in default is used).
- This change must NOT regress tool exposure — verified by the acceptance test below. If verification reveals a residual place where the classifier `type` still suppresses tool exposure (e.g. the assembled action/chat selection affecting `ctx.activeTools`), that suppression is removed as part of this work so tool exposure depends only on the RAG-strategy path.

### Out of scope
- Changing the default embedder/threshold values (deployment concern; documented).
- The classifier's multi-step splitting behavior (unchanged).
- `pipeline.rag.{name}` multi-store embedder sharing (#141).

## Testing

- **Strategy units** (`packages/llm-agent-libs/src/pipeline/tool-selection/__tests__/`):
  - `TopKToolSelection.select(results)` returns results unchanged.
  - `ScoreThresholdToolSelection(0.4).select` keeps only `score >= 0.4`; an all-below-threshold input → `[]`.
- **Factory** (`config.ts` tests): `resolveToolSelectionStrategy('top-k')` / `('threshold', {minScore})` return the right instances; unknown name throws; `threshold` without `minScore` throws.
- **tool-select handler**: with a `ScoreThresholdToolSelection`, a results set mixing high/low scores exposes only the high-score `tool:` matches; with `TopKToolSelection` all `tool:` matches are exposed (regression guard).
- **Builder/DI precedence**: `withToolSelectionStrategy` wins over YAML.
- **Domain-neutral acceptance**: a config using the default (non-SAP) classifier prompt + the canonical query `"Прочитай структуру таблиці T100"` selects the T100 tool via semantic RAG — i.e. without any SAP-specific classifier rules. (Use a stub embedder/RAG so the test is deterministic and offline.)

## Acceptance criteria (from #135)
1. Tool exposure is driven by RAG semantic distance via a pluggable strategy, not classifier domain rules.
2. SAP-specific routing rules are removed from `examples/*/smart-server.yaml`; the canonical query still routes to the tool.
3. A score-threshold strategy exists and is selectable via YAML (`agent.toolSelection`) and the builder (`withToolSelectionStrategy`); default `top-k` preserves current behavior.
