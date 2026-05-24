# Tool-Selection Strategy + Domain-Neutral Tool Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LLM tool exposure driven purely by RAG semantic distance via a pluggable `IToolSelectionStrategy` (with a score-threshold implementation), selectable from YAML or the builder, and remove SAP-specific routing rules from the classifier so tool exposure is domain-neutral.

**Architecture:** A small strategy interface in the contracts package filters scored RAG results before the `tool:`-id extraction in `ToolSelectHandler`. Default `TopKToolSelection` = today's behavior (zero regression); `ScoreThresholdToolSelection` drops tools below a cosine-score cutoff so off-topic chat surfaces no tools — no classifier gate, no domain rules. The strategy threads from `SmartAgentBuilder` → `PipelineDeps` → `DefaultPipeline._buildContext` → `PipelineContext`, mirroring how `embedder` already flows; YAML `agent.toolSelection` resolves a named strategy in `config.ts`.

**Tech Stack:** TypeScript (ESM, strict), Biome, `node:test` (`node --import tsx/esm --test`), monorepo `tsc -b`. Packages: `@mcp-abap-adt/llm-agent` (interface), `@mcp-abap-adt/llm-agent-libs` (strategies + pipeline), `@mcp-abap-adt/llm-agent-server` (YAML config).

**Spec:** `docs/superpowers/specs/2026-05-24-tool-selection-strategy-design.md`

**Conventions:** ESM, `.js` import extensions, single quotes, 2-space, semicolons, NO `any`. Run `npm run build` + `npm run lint:check` before every commit. Default behavior MUST stay `top-k` (no regression). Current base: main @ v16.0.0.

---

## File Structure

**New:**
- `packages/llm-agent/src/interfaces/tool-selection-strategy.ts` — `IToolSelectionStrategy` interface.
- `packages/llm-agent-libs/src/pipeline/tool-selection/top-k.ts` — `TopKToolSelection` (default).
- `packages/llm-agent-libs/src/pipeline/tool-selection/score-threshold.ts` — `ScoreThresholdToolSelection`.
- `packages/llm-agent-libs/src/pipeline/tool-selection/index.ts` — barrel + default singleton.
- `packages/llm-agent-libs/src/pipeline/tool-selection/__tests__/strategies.test.ts` — strategy units.

**Modified:**
- `packages/llm-agent/src/interfaces/index.ts` — re-export the interface.
- `packages/llm-agent-libs/src/pipeline/context.ts` — `PipelineContext.toolSelectionStrategy?`.
- `packages/llm-agent-libs/src/interfaces/pipeline.ts` — `PipelineDeps.toolSelectionStrategy?`.
- `packages/llm-agent-libs/src/pipeline/default-pipeline.ts` — copy dep into context in `_buildContext`.
- `packages/llm-agent-libs/src/pipeline/handlers/tool-select.ts` — delegate result filtering to the strategy.
- `packages/llm-agent-libs/src/builder.ts` — `withToolSelectionStrategy` + pass into `initialize`.
- `packages/llm-agent-server/src/smart-agent/config.ts` — `resolveToolSelectionStrategy` factory + `agent.toolSelection` validation.
- `packages/llm-agent-server/src/smart-agent/smart-server.ts` — `SmartServerAgentConfig.toolSelection` type + wire resolved strategy to builder.
- example YAMLs with SAP classifier rules; `CHANGELOG.md`; docs.

---

## Task 1: `IToolSelectionStrategy` interface + built-in strategies

**Files:**
- Create: `packages/llm-agent/src/interfaces/tool-selection-strategy.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`
- Create: `packages/llm-agent-libs/src/pipeline/tool-selection/top-k.ts`
- Create: `packages/llm-agent-libs/src/pipeline/tool-selection/score-threshold.ts`
- Create: `packages/llm-agent-libs/src/pipeline/tool-selection/index.ts`
- Test: `packages/llm-agent-libs/src/pipeline/tool-selection/__tests__/strategies.test.ts`

- [ ] **Step 1: Create the interface** `packages/llm-agent/src/interfaces/tool-selection-strategy.ts`

```ts
import type { RagResult } from './types.js';

/**
 * Decides which scored RAG results are relevant enough to drive tool exposure.
 *
 * Input: RAG results gathered for tool discovery (already top-K from the store
 * query, each carrying a cosine `score` in [0,1]). Output: the subset to keep.
 * The pipeline then extracts `tool:`-prefixed ids from the kept results.
 *
 * Pure and side-effect-free so it can be unit-tested in isolation.
 */
export interface IToolSelectionStrategy {
  readonly name: string;
  select(results: RagResult[]): RagResult[];
}
```

- [ ] **Step 2: Re-export from the interfaces barrel** — add to `packages/llm-agent/src/interfaces/index.ts` (next to the other strategy exports such as `ILlmCallStrategy`):

```ts
export type { IToolSelectionStrategy } from './tool-selection-strategy.js';
```

- [ ] **Step 3: Write failing strategy tests** `packages/llm-agent-libs/src/pipeline/tool-selection/__tests__/strategies.test.ts`

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RagResult } from '@mcp-abap-adt/llm-agent';
import { ScoreThresholdToolSelection } from '../score-threshold.js';
import { TopKToolSelection } from '../top-k.js';

const r = (id: string, score: number): RagResult => ({
  text: id,
  metadata: { id },
  score,
});

describe('TopKToolSelection', () => {
  it('returns all results unchanged (name top-k)', () => {
    const s = new TopKToolSelection();
    const input = [r('tool:a', 0.9), r('tool:b', 0.1)];
    assert.equal(s.name, 'top-k');
    assert.deepEqual(s.select(input), input);
  });
});

describe('ScoreThresholdToolSelection', () => {
  it('keeps only results with score >= minScore (name threshold)', () => {
    const s = new ScoreThresholdToolSelection(0.4);
    assert.equal(s.name, 'threshold');
    const kept = s.select([r('tool:a', 0.9), r('tool:b', 0.39), r('tool:c', 0.4)]);
    assert.deepEqual(
      kept.map((x) => x.metadata.id),
      ['tool:a', 'tool:c'],
    );
  });

  it('returns empty when all scores are below threshold', () => {
    const s = new ScoreThresholdToolSelection(0.5);
    assert.deepEqual(s.select([r('tool:a', 0.1), r('tool:b', 0.2)]), []);
  });
});
```

Note: `RagResult.metadata` is typed `RagMetadata` (has at least `id`); the test fixture only sets `id`, cast is unnecessary because `id` is the field used. If `RagMetadata` requires more fields, add them as `{ id } as RagMetadata` minimal cast — check `packages/llm-agent/src/interfaces/types.ts` for the exact `RagMetadata` shape and satisfy it.

- [ ] **Step 4: Run tests, confirm FAIL**

Run: `cd packages/llm-agent-libs && node --import tsx/esm --test 'src/pipeline/tool-selection/__tests__/strategies.test.ts'`
Expected: FAIL — `Cannot find module '../top-k.js'`.

- [ ] **Step 5: Implement `TopKToolSelection`** `packages/llm-agent-libs/src/pipeline/tool-selection/top-k.ts`

```ts
import type { IToolSelectionStrategy, RagResult } from '@mcp-abap-adt/llm-agent';

/**
 * Default strategy: passthrough. The top-K cap is already applied at the RAG
 * store query, so keeping all results reproduces the historical behavior.
 */
export class TopKToolSelection implements IToolSelectionStrategy {
  readonly name = 'top-k';
  select(results: RagResult[]): RagResult[] {
    return results;
  }
}
```

- [ ] **Step 6: Implement `ScoreThresholdToolSelection`** `packages/llm-agent-libs/src/pipeline/tool-selection/score-threshold.ts`

```ts
import type { IToolSelectionStrategy, RagResult } from '@mcp-abap-adt/llm-agent';

/**
 * Keeps only results whose cosine score is at or above `minScore`. A query
 * whose nearest tools all score below the cutoff yields an empty set, so no
 * tools are surfaced and the LLM answers as plain chat — semantic distance
 * decides both *which* tools and *whether any*, with no classifier gate.
 *
 * `minScore` is embedder-dependent and is the deployment's choice.
 */
export class ScoreThresholdToolSelection implements IToolSelectionStrategy {
  readonly name = 'threshold';
  constructor(private readonly minScore: number) {}
  select(results: RagResult[]): RagResult[] {
    return results.filter((r) => r.score >= this.minScore);
  }
}
```

- [ ] **Step 7: Barrel + default singleton** `packages/llm-agent-libs/src/pipeline/tool-selection/index.ts`

```ts
import { TopKToolSelection } from './top-k.js';

export { TopKToolSelection } from './top-k.js';
export { ScoreThresholdToolSelection } from './score-threshold.js';

/** Shared default used when no strategy is configured. */
export const DEFAULT_TOOL_SELECTION = new TopKToolSelection();
```

- [ ] **Step 8: Run tests, confirm PASS**

Run: `cd packages/llm-agent-libs && node --import tsx/esm --test 'src/pipeline/tool-selection/__tests__/strategies.test.ts'`
Expected: PASS — 3 tests.

- [ ] **Step 9: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: PASS. (Strategies must be exported from the libs public surface if consumers need them — check `packages/llm-agent-libs/src/index.ts` and add `export { TopKToolSelection, ScoreThresholdToolSelection } from './pipeline/tool-selection/index.js';` so YAML resolution + builder users can import them.)

- [ ] **Step 10: Commit**

```bash
git add packages/llm-agent/src/interfaces/tool-selection-strategy.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent-libs/src/pipeline/tool-selection packages/llm-agent-libs/src/index.ts
git commit -m "feat(libs): add IToolSelectionStrategy + TopK/ScoreThreshold strategies"
```

---

## Task 2: Thread the strategy through deps → context → tool-select handler

**Files:**
- Modify: `packages/llm-agent-libs/src/interfaces/pipeline.ts` (`PipelineDeps`)
- Modify: `packages/llm-agent-libs/src/pipeline/context.ts` (`PipelineContext`)
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts` (`_buildContext`, ~line 396)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-select.ts` (lines 94-99)
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-select-strategy.test.ts` (new) OR extend existing tool-select test

- [ ] **Step 1: Add field to `PipelineDeps`** (`interfaces/pipeline.ts`) — add after `embedder?` (import the type at top: `import type { IToolSelectionStrategy } from '@mcp-abap-adt/llm-agent';`):

```ts
  /** Strategy that filters scored RAG results for tool exposure. Default: top-k. */
  toolSelectionStrategy?: IToolSelectionStrategy;
```

- [ ] **Step 2: Add field to `PipelineContext`** (`pipeline/context.ts`) — add near `embedder` (line ~105), import `IToolSelectionStrategy` from `@mcp-abap-adt/llm-agent`:

```ts
  readonly toolSelectionStrategy: IToolSelectionStrategy | undefined;
```

- [ ] **Step 3: Copy dep into context** (`default-pipeline.ts` `_buildContext`, next to `embedder: this.deps.embedder,` ~line 396):

```ts
      toolSelectionStrategy: this.deps.toolSelectionStrategy,
```

- [ ] **Step 4: Write the failing handler test** `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-select-strategy.test.ts`

Construct a minimal `PipelineContext`-like object exercising `ToolSelectHandler.execute`. Read the existing tool-select test (if any) for the context-stub pattern; otherwise stub the fields the handler reads: `ctx.config.mode`, `ctx.mcpTools`, `ctx.mcpClients` (empty), `ctx.ragResults` (pre-populated so the self-heal branch is skipped), `ctx.externalTools` (empty), `ctx.toolAvailabilityRegistry` (a registry whose `filterTools` returns `{allowed: input, blocked: []}`), `ctx.toolSelectionStrategy`, `ctx.options`, `ctx.sessionId`. Assert that with a `ScoreThresholdToolSelection(0.5)` and ragResults `[{id:'tool:keep',score:0.9},{id:'tool:drop',score:0.1}]` plus `mcpTools=[{name:'keep'},{name:'drop'}]`, only `keep` ends up in `ctx.activeTools`; and with `TopKToolSelection` (or undefined) both are selected.

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ScoreThresholdToolSelection, TopKToolSelection } from '../../tool-selection/index.js';
import { ToolSelectHandler } from '../tool-select.js';
// ... build a ctx stub (see existing handler tests for the helper); then:
//   ctx.ragResults = { tools: [ {text:'', metadata:{id:'tool:keep'}, score:0.9}, {text:'', metadata:{id:'tool:drop'}, score:0.1} ] };
//   ctx.mcpTools = [{name:'keep', ...}, {name:'drop', ...}];
// threshold case:
//   ctx.toolSelectionStrategy = new ScoreThresholdToolSelection(0.5);
//   await new ToolSelectHandler().execute(ctx, {}, span);
//   assert.deepEqual(ctx.activeTools.map(t=>t.name), ['keep']);
// top-k / undefined case → ['keep','drop'].
```
(Use the same `span`/registry stubs the existing `tool-select` or `server` tests use. If no handler-level test harness exists, build the minimal ctx inline — the handler only touches the listed fields.)

- [ ] **Step 5: Run test, confirm FAIL**

Run: `cd packages/llm-agent-libs && node --import tsx/esm --test 'src/pipeline/handlers/__tests__/tool-select-strategy.test.ts'`
Expected: FAIL — handler still selects both tools (no strategy filtering yet).

- [ ] **Step 6: Apply the strategy in `tool-select.ts`** — replace the current `ragToolNames` computation (lines 94-99):

```ts
    // Select tools based on RAG results
    const ragToolNames = new Set(
      allRagResults
        .map((r) => r.metadata.id as string)
        .filter((id) => id?.startsWith('tool:'))
        .map((id) => id.slice(5).replace(/:.*$/, '')),
    );
```

with strategy-filtered results (add `import { DEFAULT_TOOL_SELECTION } from '../tool-selection/index.js';` at the top of the file):

```ts
    // Filter RAG results by the configured relevance strategy (default: top-k).
    const strategy = ctx.toolSelectionStrategy ?? DEFAULT_TOOL_SELECTION;
    const relevant = strategy.select(allRagResults);

    // Select tools based on the strategy-filtered RAG results
    const ragToolNames = new Set(
      relevant
        .map((r) => r.metadata.id as string)
        .filter((id) => id?.startsWith('tool:'))
        .map((id) => id.slice(5).replace(/:.*$/, '')),
    );
```

Also add the strategy name to the `tools_selected` log step (find the `logStep('tools_selected', {...})` call ~line 131) by adding `toolSelectionStrategy: strategy.name,` to its payload.

- [ ] **Step 7: Run test, confirm PASS**

Run: `cd packages/llm-agent-libs && node --import tsx/esm --test 'src/pipeline/handlers/__tests__/tool-select-strategy.test.ts'`
Expected: PASS (threshold → only `keep`; top-k → both).

- [ ] **Step 8: Build + lint + regression**

Run: `npm run build && npm run lint:check && (cd packages/llm-agent-libs && node --import tsx/esm --test 'src/**/*.test.ts' 2>&1 | tail -4)`
Expected: PASS, no regressions (default top-k unchanged).

- [ ] **Step 9: Commit**

```bash
git add packages/llm-agent-libs/src/interfaces/pipeline.ts packages/llm-agent-libs/src/pipeline/context.ts packages/llm-agent-libs/src/pipeline/default-pipeline.ts packages/llm-agent-libs/src/pipeline/handlers/tool-select.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-select-strategy.test.ts
git commit -m "feat(libs): tool-select delegates RAG-result filtering to IToolSelectionStrategy"
```

---

## Task 3: Builder API — `withToolSelectionStrategy`

**Files:**
- Modify: `packages/llm-agent-libs/src/builder.ts` (private field, method, `initialize` call ~line 1248)
- Test: `packages/llm-agent-libs/src/__tests__/builder-tool-selection.test.ts` (new)

- [ ] **Step 1: Add the private field + method** in `SmartAgentBuilder` (near `withEmbedder`, ~line 436). Import `IToolSelectionStrategy` from `@mcp-abap-adt/llm-agent` if not already imported.

```ts
  private _toolSelectionStrategy?: IToolSelectionStrategy;

  /** Set the strategy that filters scored RAG results for tool exposure. */
  withToolSelectionStrategy(strategy: IToolSelectionStrategy): this {
    this._toolSelectionStrategy = strategy;
    return this;
  }
```

- [ ] **Step 2: Pass it into `pipeline.initialize`** (the deps object ~line 1248, next to `embedder: this._embedder,`):

```ts
      toolSelectionStrategy: this._toolSelectionStrategy,
```

- [ ] **Step 3: Write the failing test** `packages/llm-agent-libs/src/__tests__/builder-tool-selection.test.ts`

Build an agent with a stub `ScoreThresholdToolSelection` via `withToolSelectionStrategy`, and assert it reaches the pipeline context. The cleanest observable: dispatch a request through the built agent with a stubbed tools RAG and confirm only above-threshold tools are active — but that is heavy. Prefer a focused assertion: expose nothing new publicly; instead verify via the same handler-level path by constructing the builder, building, and checking that a request surfaces the threshold behavior. If the builder/pipeline does not expose the context for inspection, assert behavior through `agent.run`-style dispatch with a stub RAG store returning mixed scores (mirror an existing builder test that exercises tool selection). Reuse the closest existing builder test harness; do not invent new public API.

```ts
// Pattern: copy the setup from an existing builder test that wires a fake
// toolsRag + mainLlm, add `.withToolSelectionStrategy(new ScoreThresholdToolSelection(0.5))`,
// run a query, and assert the LLM was offered only the above-threshold tool.
```
(If a pure behavior test is impractical, a minimally acceptable test: build via the builder, then assert the constructed pipeline's deps include the strategy — only if the test can reach it without new public surface. Otherwise rely on Task 2's handler test for the filtering correctness and keep this test to "DI strategy wins": construct with `withToolSelectionStrategy(stub)` and a YAML-style default, assert the stub is used.)

- [ ] **Step 4: Run test, confirm FAIL then implement-as-needed then PASS**

Run: `cd packages/llm-agent-libs && node --import tsx/esm --test 'src/__tests__/builder-tool-selection.test.ts'`
After Steps 1-2 the wiring exists; ensure the test passes. Expected: PASS.

- [ ] **Step 5: Build + lint + full libs tests**

Run: `npm run build && npm run lint:check && (cd packages/llm-agent-libs && node --import tsx/esm --test 'src/**/*.test.ts' 2>&1 | tail -4)`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/builder.ts packages/llm-agent-libs/src/__tests__/builder-tool-selection.test.ts
git commit -m "feat(libs): SmartAgentBuilder.withToolSelectionStrategy (DI)"
```

---

## Task 4: YAML config + `resolveToolSelectionStrategy` factory (server)

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts` (factory + `SmartServerAgentConfig` resolution)
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` (`SmartServerAgentConfig.toolSelection` type + wire to builder in `_buildAgent`)
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/tool-selection-config.test.ts` (new)

- [ ] **Step 1: Add the factory** in `config.ts` (mirror `resolveCoordinatorPlanning`; place near it). Import the strategies + type:

```ts
import {
  ScoreThresholdToolSelection,
  TopKToolSelection,
} from '@mcp-abap-adt/llm-agent-libs';
import type { IToolSelectionStrategy } from '@mcp-abap-adt/llm-agent';

export function resolveToolSelectionStrategy(
  name: string,
  params?: { minScore?: number },
): IToolSelectionStrategy {
  switch (name) {
    case 'top-k':
      return new TopKToolSelection();
    case 'threshold': {
      const minScore = params?.minScore;
      if (typeof minScore !== 'number') {
        throw new Error(
          "agent.toolSelection.strategy 'threshold' requires a numeric 'minScore'",
        );
      }
      return new ScoreThresholdToolSelection(minScore);
    }
    default:
      throw new Error(
        `Unknown agent.toolSelection.strategy '${name}'. Allowed: top-k, threshold.`,
      );
  }
}
```

- [ ] **Step 2: Add the config type** to `SmartServerAgentConfig` in `smart-server.ts` (find `interface SmartServerAgentConfig`):

```ts
  /** Tool-selection strategy over RAG results. Default: top-k. */
  toolSelection?: { strategy: string; minScore?: number };
```

- [ ] **Step 3: Resolve in `resolveSmartServerConfig`** — read `agent.toolSelection` from YAML into the resolved `agent` object (it is plain config passed through; if `resolveSmartServerConfig` builds `agent` field-by-field, add `toolSelection: get(yaml, 'agent', 'toolSelection')`; if it spreads the agent block, no change needed — verify how `agent` is assembled and ensure `toolSelection` survives).

- [ ] **Step 4: Wire to the builder** in `smart-server.ts` `_buildAgent` (near `withCoordinator`/`withEmbedder`). DI (`this.cfg`-injected strategy, if any future field) is out of scope; the server path resolves from YAML:

```ts
    const toolSelectionCfg = this.cfg.agent?.toolSelection;
    if (toolSelectionCfg?.strategy) {
      builder = builder.withToolSelectionStrategy(
        resolveToolSelectionStrategy(toolSelectionCfg.strategy, {
          minScore: toolSelectionCfg.minScore,
        }),
      );
    }
```
(When absent, the builder/handler default `top-k` applies — no call needed.)

- [ ] **Step 5: Write the failing factory tests** `packages/llm-agent-server/src/smart-agent/__tests__/tool-selection-config.test.ts`

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveToolSelectionStrategy } from '../config.js';

describe('resolveToolSelectionStrategy', () => {
  it('resolves top-k', () => {
    assert.equal(resolveToolSelectionStrategy('top-k').name, 'top-k');
  });
  it('resolves threshold with minScore', () => {
    const s = resolveToolSelectionStrategy('threshold', { minScore: 0.3 });
    assert.equal(s.name, 'threshold');
  });
  it('throws when threshold has no minScore', () => {
    assert.throws(
      () => resolveToolSelectionStrategy('threshold'),
      /minScore/,
    );
  });
  it('throws on unknown strategy', () => {
    assert.throws(
      () => resolveToolSelectionStrategy('bogus'),
      /Allowed: top-k, threshold/,
    );
  });
});
```

- [ ] **Step 6: Run tests, confirm FAIL then PASS**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/tool-selection-config.test.ts'`
Expected: FAIL (no factory) → after Step 1 → PASS (4 tests).

- [ ] **Step 7: Build + lint + full server tests**

Run: `npm run build && npm run lint:check && (cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/*.test.ts' 2>&1 | tail -4)`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/config.ts packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/tool-selection-config.test.ts
git commit -m "feat(server): agent.toolSelection YAML config + resolveToolSelectionStrategy"
```

---

## Task 5: Domain-neutral classifier — remove SAP rules from examples + acceptance tests

**Files:**
- Modify: example YAMLs whose `prompts.classifier` encodes SAP/domain routing (grep first)
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/domain-neutral-tool-exposure.test.ts` (new)

- [ ] **Step 1: Find the SAP-specific classifier prompts**

Run: `rg -ln "sap-abap|SAP terms|knowledge.*MUST.*action|Knowledge/factual" examples docs/examples --glob '*.yaml'`
List every example whose `prompts.classifier` contains domain routing rules (issue names `examples/sap-ai-core-direct/smart-server.yaml`, `examples/docker-sap-ai-core/smart-server.yaml`).

- [ ] **Step 2: Remove the domain rules** — for each, delete the `prompts.classifier` override entirely (so the built-in default domain-neutral classifier prompt is used) OR replace its body with a domain-neutral structural-intent prompt. Prefer deletion of the override when the only reason it existed was SAP routing. Keep any non-routing customization. After editing, confirm no `sap-abap`/`SAP terms` routing rule remains in example classifier prompts (re-run the Step 1 grep → no classifier-routing hits).

- [ ] **Step 3: Write the acceptance test** `packages/llm-agent-server/src/smart-agent/__tests__/domain-neutral-tool-exposure.test.ts`

Deterministic + offline: stub the tools RAG store to return controlled `tool:` results with controlled scores per query, stub the embedder, and a stub classifier LLM that uses NO SAP rules (or classificationEnabled false). Exercise the tool-select path (reuse Task 2's ctx-stub helper) twice:

```ts
// Positive: query "Прочитай структуру таблиці T100", tools RAG stubbed to score
//   tool:GetTableStructure at 0.8. With ScoreThresholdToolSelection(0.5) →
//   ctx.activeTools includes 'GetTableStructure' — without any SAP classifier rule.
// Negative: query "привіт, як справи" (off-topic), tools RAG stubbed so every
//   tool scores 0.1. With ScoreThresholdToolSelection(0.5) → ctx.activeTools is [].
```
This proves tool exposure is driven by semantic distance + strategy, not by domain classifier rules, and that off-topic chat surfaces zero tools.

- [ ] **Step 4: Run, confirm PASS**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/domain-neutral-tool-exposure.test.ts'`
Expected: PASS (positive surfaces the tool; negative surfaces none).

- [ ] **Step 5: Verify no residual classify→tool suppression**

Manually trace: with the SAP rules removed and `classificationEnabled` default, does a query classified as `chat` still reach `tool-select` (which self-heals and queries the tools store)? `ToolSelectHandler` runs unconditionally and self-heals (lines 50-91), so tools are discovered regardless. Confirm `assemble.ts` does not drop `ctx.activeTools` when the primary subprompt is `chat` — read `assemble.ts` around the `tools:` assignment; if it filters tools by the action/chat selection, adjust so `ctx.activeTools` (RAG-strategy-selected) is always offered to the LLM. If no such suppression exists, note it and move on.

- [ ] **Step 6: Build + lint + full server tests; commit**

Run: `npm run build && npm run lint:check && (cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/*.test.ts' 2>&1 | tail -4)`
```bash
git add examples docs/examples packages/llm-agent-server/src/smart-agent/__tests__/domain-neutral-tool-exposure.test.ts packages/llm-agent-libs
git commit -m "feat(examples): drop SAP-specific classifier routing; tool exposure is semantic-distance-driven (#135)"
```

---

## Task 6: Docs + CHANGELOG

**Files:**
- Modify: `docs/QUICK_START.md` and/or `docs/PERFORMANCE.md`, `CHANGELOG.md`

- [ ] **Step 1: Document `agent.toolSelection`** in `docs/PERFORMANCE.md` (near the embedder/strategy section) and a short note in `docs/QUICK_START.md`: the tool list is chosen by semantic distance over the tools RAG store; `agent.toolSelection.strategy: top-k` (default) exposes the K nearest; `threshold` (with `minScore`) exposes only tools at/above the cosine cutoff so off-topic queries surface none. Note `minScore` is embedder-specific (calibrate for bge-m3). Mention the builder equivalent `withToolSelectionStrategy(...)`. State that domain-specific classifier rules are no longer needed for tool routing.

- [ ] **Step 2: CHANGELOG `[Unreleased]`** — add under `### Added` (or `### Changed`):

```markdown
### Added
- **Pluggable tool-selection strategy** (`agent.toolSelection` / `SmartAgentBuilder.withToolSelectionStrategy`). `top-k` (default, unchanged behavior) exposes the K nearest tools by semantic distance; `threshold` (`minScore`) exposes only tools at/above a cosine-score cutoff, so off-topic queries surface no tools. Tool exposure is now driven purely by RAG semantic distance — SAP-specific classifier routing rules were removed from the examples. (#135)
```

- [ ] **Step 3: Doc sweep** — `rg -n "sap-abab|SAP terms|classifier.*SAP" docs README.md --glob '!docs/superpowers/**'` and fix any prose claiming the classifier must encode domain rules to route to tools.

- [ ] **Step 4: Build + lint; commit**

```bash
git add docs CHANGELOG.md
git commit -m "docs: document agent.toolSelection strategy + domain-neutral tool exposure (#135)"
```

---

## Task 7: Delete spec + plan, final verification

- [ ] **Step 1: Final full verification**

Run:
```bash
npm run build && npm run lint:check \
  && (cd packages/llm-agent-libs && node --import tsx/esm --test 'src/**/*.test.ts' 2>&1 | tail -4) \
  && (cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/*.test.ts' 2>&1 | tail -4)
```
Expected: all PASS.

- [ ] **Step 2: Delete spec + plan** (per CLAUDE.md no-retention — defer to just before merge if the reviewer wants them visible):

```bash
git rm docs/superpowers/specs/2026-05-24-tool-selection-strategy-design.md docs/superpowers/plans/2026-05-24-tool-selection-strategy.md
git commit -m "chore: remove implemented #135 spec + plan (history in git)"
```

---

## Self-Review

**1. Spec coverage:**
- `IToolSelectionStrategy` + TopK/Threshold → Task 1.
- tool-select delegates to strategy → Task 2.
- Wiring path (PipelineDeps → context → _buildContext → builder.initialize) → Tasks 2+3.
- Builder `withToolSelectionStrategy` (DI) → Task 3.
- YAML `agent.toolSelection` + `resolveToolSelectionStrategy` + fail-loud validation → Task 4.
- Default top-k, no regression → Tasks 1/2 (passthrough) + regression runs each task.
- Domain-neutral classifier (remove SAP rules) + positive & negative acceptance → Task 5.
- Docs + CHANGELOG → Task 6.
- Spec/plan deletion → Task 7.

**2. Placeholder scan:** Task 3's builder test and Task 5's ctx-stub reference "reuse the existing harness" rather than full code — this is deliberate because the exact stub shape depends on the existing test helpers the implementer must read; the assertions and fixtures (scores, expected tool names) are concrete. All production code steps show full code.

**3. Type consistency:** `IToolSelectionStrategy.select(results: RagResult[]): RagResult[]` + `name` used identically across Tasks 1-4. `RagResult` imported from `./types.js` (contracts) / `@mcp-abap-adt/llm-agent` (consumers). `toolSelectionStrategy?` field name identical in PipelineDeps, PipelineContext, builder, and the `initialize` call. Factory `resolveToolSelectionStrategy(name, params?)` signature consistent between config.ts and its tests. `DEFAULT_TOOL_SELECTION` singleton used as the handler fallback.

No blocking issues. Plan ready for execution.
