# Consumer-Defined RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove hardcoded facts/feedback/state RAG stores, introduce `IPipeline` interface with `DefaultPipeline` (tools + history only), scope model, and plugin system for consumer-defined stores.

**Architecture:** Two-level split — Builder handles global DI (LLM, embedder, MCP, tools/history RAG, pipeline), Pipeline handles request orchestration. `DefaultPipeline` replaces the structured stage-tree executor. Consumer extends via custom `IPipeline` implementations with plugins.

**Tech Stack:** TypeScript (ESM, strict mode), Biome lint/format

**Spec:** `docs/superpowers/specs/2026-04-09-consumer-defined-rag-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/smart-agent/interfaces/pipeline.ts` | `IPipeline` interface |
| `src/smart-agent/interfaces/plugin.ts` | `ISmartAgentPlugin`, `IRagStoreConfig`, `RagScope` types |
| `src/smart-agent/pipeline/default-pipeline.ts` | `DefaultPipeline` — rewrite as `IPipeline` implementation (tools + history only) |

### Modified files

| File | Changes |
|------|---------|
| `src/smart-agent/builder.ts` | Remove `withRag`, `withRagUpsert`, `withRagRetrieval`, `withRagTranslation`, `withPipeline`, `withStageHandler`. Add `setToolsRag`, `setHistoryRag`, `setPipeline`. Refactor `build()` to use `IPipeline`. |
| `src/smart-agent/agent.ts` | Remove `SmartAgentRagStores` generic, `ragUpsertEnabled`, `ragRetrievalMode`, `ragTranslationEnabled` from config. Add `IPipeline` to deps, delegate `streamProcess` to pipeline. |
| `src/smart-agent/pipeline/context.ts` | Simplify — remove `shouldRetrieve`, `isSapRequired`, `isAscii` control flags. Remove `ragStores` (pipeline owns stores). |
| `src/smart-agent/classifier/llm-classifier.ts` | Remove `fact`, `feedback`, `state` from `VALID_TYPES`. Keep `action`, `chat`. |
| `src/smart-agent/smart-server.ts` | Remove default facts/feedback/state creation. Remove `rag` config handling for stores. |
| `src/smart-agent/pipeline/handlers/rag-upsert.ts` | Delete file |
| `src/smart-agent/pipeline/handlers/rag-query.ts` | Keep handler, remove namespace-based filtering, add scope-based filtering |
| `src/smart-agent/pipeline/executor.ts` | Keep for now — `DefaultPipeline` may reuse internally or inline logic |
| `src/smart-agent/pipeline/handlers/index.ts` | Remove `rag-upsert` from default registry |
| `src/smart-agent/pipeline/types.ts` | Remove `rag-upsert` from `BuiltInStageType`. Remove structured pipeline YAML types if no longer needed by core. |
| `src/smart-agent/pipeline/handlers/classify.ts` | Remove `shouldRetrieve`/`isSapRequired` flag logic |
| `src/smart-agent/pipeline/handlers/tool-select.ts` | Adapt to read from `ragResults.tools` directly |
| `src/index.ts` | Update exports: add `IPipeline`, `DefaultPipeline`, `ISmartAgentPlugin`, `IRagStoreConfig`, `RagScope`. Remove `getDefaultPipelineDefinition`, `StructuredPipelineDefinition`. |

### Deleted files

| File | Reason |
|------|--------|
| `src/smart-agent/pipeline/handlers/rag-upsert.ts` | No auto-upsert in core |

---

## Task 1: Define `IPipeline` interface and plugin types

**Files:**
- Create: `src/smart-agent/interfaces/pipeline.ts`
- Create: `src/smart-agent/interfaces/plugin.ts`
- Modify: `src/smart-agent/interfaces/rag.ts` (add `RagScope` if needed)
- Modify: `src/index.ts` (export new types)

- [ ] **Step 1: Create `IPipeline` interface**

```typescript
// src/smart-agent/interfaces/pipeline.ts
import type { Result } from './types.js';
import type { Message } from '../../types.js';
import type { LlmStreamChunk, CallOptions } from './types.js';
import type { OrchestratorError } from '../agent.js';

/**
 * IPipeline — orchestrates request processing.
 *
 * Implementations control the full request lifecycle: classification,
 * RAG query/upsert, tool selection, LLM calls, and streaming.
 *
 * Builder injects dependencies via `initialize()` before the first request.
 */
export interface IPipeline {
  /**
   * Called once after build() to inject dependencies the pipeline needs.
   * The pipeline stores references internally.
   */
  initialize(deps: PipelineDeps): void;

  /**
   * Process a user request. Yields streaming chunks to the consumer.
   *
   * @param input  - User message (string or message array).
   * @param history - Conversation history.
   * @param options - Call options (sessionId, signal, logger, etc.).
   * @param yieldChunk - Callback to push streaming chunks.
   * @returns Final timing entries and optional error.
   */
  execute(
    input: string | Message[],
    history: Message[],
    options: CallOptions | undefined,
    yieldChunk: (chunk: Result<LlmStreamChunk, OrchestratorError>) => void,
  ): Promise<PipelineResult>;
}

export interface PipelineDeps {
  mainLlm: ILlm;
  helperLlm?: ILlm;
  classifierLlm?: ILlm;
  mcpClients: IMcpClient[];
  toolsRag?: IRag;
  historyRag?: IRag;
  embedder?: IEmbedder;
  reranker?: IReranker;
  queryExpander?: IQueryExpander;
  skillManager?: ISkillManager;
  toolPolicy?: IToolPolicy;
  injectionDetector?: IPromptInjectionDetector;
  toolCache?: IToolCache;
  outputValidator?: IOutputValidator;
  sessionManager?: ISessionManager;
  historyMemory?: IHistoryMemory;
  historySummarizer?: IHistorySummarizer;
  llmCallStrategy?: ILlmCallStrategy;
  logger?: ILogger;
  requestLogger?: IRequestLogger;
  tracer?: ITracer;
  metrics?: IMetrics;
  classifier?: ISubpromptClassifier;
  assembler?: IContextAssembler;
}

export interface PipelineResult {
  timing: TimingEntry[];
  error?: OrchestratorError;
}
```

Adjust imports to reference the actual interface locations in the project. The exact import paths depend on the current file structure — use `.js` extensions per project convention.

- [ ] **Step 2: Create plugin and scope types**

```typescript
// src/smart-agent/interfaces/plugin.ts
import type { IRag } from './rag.js';

export type RagScope = 'global' | 'user' | 'session';

export interface IRagStoreConfig {
  rag: IRag;
  scope: RagScope;
  /** Default TTL in seconds for records in this store. */
  ttl?: number;
}

/**
 * ISmartAgentPlugin — extends a consumer pipeline with additional
 * RAG stores and classifier knowledge.
 *
 * Plugins are passed to consumer pipeline implementations, not to builder.
 * The default pipeline ignores plugins.
 */
export interface ISmartAgentPlugin {
  name: string;
  ragStores: Record<string, IRagStoreConfig>;
  /** Additional classifier prompt instructions for this plugin's store types. */
  classifierPromptExtension?: string;
}
```

- [ ] **Step 3: Export new types from index.ts**

Add to `src/index.ts`:
```typescript
export type { IPipeline, PipelineDeps, PipelineResult } from './smart-agent/interfaces/pipeline.js';
export type { ISmartAgentPlugin, IRagStoreConfig, RagScope } from './smart-agent/interfaces/plugin.js';
```

- [ ] **Step 4: Run lint and build**

Run: `npm run lint && npm run build`
Expected: PASS — new files are types only, no logic to break.

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/interfaces/pipeline.ts src/smart-agent/interfaces/plugin.ts src/index.ts
git commit -m "feat: add IPipeline interface and plugin types (#84)"
```

---

## Task 2: Update classifier — remove fact/feedback/state types

**Files:**
- Modify: `src/smart-agent/classifier/llm-classifier.ts`

- [ ] **Step 1: Remove `fact`, `feedback`, `state` from VALID_TYPES**

In `src/smart-agent/classifier/llm-classifier.ts`, change the `VALID_TYPES` set (around line 13-19):

```typescript
// Before
const VALID_TYPES: Set<SubpromptType> = new Set([
  'fact', 'feedback', 'state', 'action', 'chat',
]);

// After
const VALID_TYPES: Set<SubpromptType> = new Set([
  'action', 'chat',
]);
```

- [ ] **Step 2: Update classifier prompt**

Remove references to `fact`, `feedback`, `state` types from the default classifier prompt (around lines 21-41). The classifier should only produce `action` and `chat` subprompts.

- [ ] **Step 3: Update `SubpromptType` type**

Find where `SubpromptType` is defined (likely in `src/smart-agent/interfaces/types.ts`) and update:

```typescript
// Before
export type SubpromptType = 'fact' | 'feedback' | 'state' | 'action' | 'chat';

// After — extensible string union
export type SubpromptType = 'action' | 'chat' | (string & {});
```

The `(string & {})` pattern allows IDE autocomplete for known types while accepting arbitrary strings from consumer classifiers.

- [ ] **Step 4: Run lint and build**

Run: `npm run lint && npm run build`
Expected: PASS. Build may show warnings if other files reference removed types — note them for later tasks.

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/classifier/llm-classifier.ts src/smart-agent/interfaces/types.ts
git commit -m "refactor: remove fact/feedback/state from default classifier (#84)"
```

---

## Task 3: Delete `RagUpsertHandler` and remove from registry

**Files:**
- Delete: `src/smart-agent/pipeline/handlers/rag-upsert.ts`
- Modify: `src/smart-agent/pipeline/handlers/index.ts`
- Modify: `src/smart-agent/pipeline/types.ts`

- [ ] **Step 1: Remove `rag-upsert` from handler registry**

In `src/smart-agent/pipeline/handlers/index.ts` (around line 32-46), remove the `rag-upsert` entry:

```typescript
// Remove this line:
['rag-upsert', new RagUpsertHandler()],
```

Also remove the import:
```typescript
// Remove:
import { RagUpsertHandler } from './rag-upsert.js';
```

- [ ] **Step 2: Remove `rag-upsert` from BuiltInStageType**

In `src/smart-agent/pipeline/types.ts` (around line 63-75), remove `'rag-upsert'` from the union.

- [ ] **Step 3: Delete `rag-upsert.ts` handler file**

```bash
rm src/smart-agent/pipeline/handlers/rag-upsert.ts
```

- [ ] **Step 4: Remove `ragUpsertEnabled` from SmartAgentConfig**

In `src/smart-agent/agent.ts` (line 151), remove:
```typescript
ragUpsertEnabled?: boolean;
```

- [ ] **Step 5: Remove `withRagUpsert` from builder**

In `src/smart-agent/builder.ts` (lines 478-481), remove the `withRagUpsert()` method entirely.

- [ ] **Step 6: Run lint and build**

Run: `npm run lint && npm run build`
Expected: Build errors where `ragUpsertEnabled` is referenced — fix any remaining references (set to ignore/remove condition checks in other handlers).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove RagUpsertHandler and ragUpsertEnabled (#84)"
```

---

## Task 4: Remove `withRag`, `withRagRetrieval`, `withRagTranslation` from builder

**Files:**
- Modify: `src/smart-agent/builder.ts`
- Modify: `src/smart-agent/agent.ts`

- [ ] **Step 1: Remove `withRag()` method**

In `src/smart-agent/builder.ts` (lines 248-252), remove `withRag()` and the `_ragStores` field it writes to.

- [ ] **Step 2: Remove `withRagRetrieval()` method**

In `src/smart-agent/builder.ts` (lines 466-469), remove the method.

- [ ] **Step 3: Remove `withRagTranslation()` method**

In `src/smart-agent/builder.ts` (lines 472-475), remove the method.

- [ ] **Step 4: Remove corresponding config fields**

In `src/smart-agent/agent.ts`, remove from `SmartAgentConfig`:
- `ragRetrievalMode`
- `ragTranslationEnabled`

- [ ] **Step 5: Add `setToolsRag()` and `setHistoryRag()` to builder**

```typescript
// In builder.ts — new DI methods

private _toolsRag?: IRag;
private _historyRag?: IRag;

setToolsRag(rag: IRag): this {
  this._toolsRag = rag;
  return this;
}

setHistoryRag(rag: IRag): this {
  this._historyRag = rag;
  return this;
}
```

- [ ] **Step 6: Add `setPipeline()` to builder**

```typescript
private _pipeline?: IPipeline;

setPipeline(pipeline: IPipeline): this {
  this._pipeline = pipeline;
  return this;
}
```

- [ ] **Step 7: Run lint and build**

Run: `npm run lint && npm run build`
Expected: Build errors from removed methods/config — note them. They will be resolved in Task 5 when `build()` is refactored.

- [ ] **Step 8: Commit**

```bash
git add src/smart-agent/builder.ts src/smart-agent/agent.ts
git commit -m "refactor: replace withRag/withRagRetrieval/withRagTranslation with DI methods (#84)"
```

---

## Task 5: Implement `DefaultPipeline`

**Files:**
- Rewrite: `src/smart-agent/pipeline/default-pipeline.ts`
- Modify: `src/smart-agent/pipeline/context.ts` (simplify control flags)
- Modify: `src/smart-agent/pipeline/handlers/classify.ts` (remove flag logic)

- [ ] **Step 1: Rewrite `default-pipeline.ts` as `IPipeline` implementation**

Replace `getDefaultPipelineDefinition()` function with a `DefaultPipeline` class:

```typescript
// src/smart-agent/pipeline/default-pipeline.ts
import type { IPipeline, PipelineDeps, PipelineResult } from '../interfaces/pipeline.js';
import type { Message } from '../../types.js';
import type { CallOptions, LlmStreamChunk, Result, TimingEntry } from '../interfaces/types.js';
import type { OrchestratorError } from '../agent.js';
import { ClassifyHandler } from './handlers/classify.js';
import { SummarizeHandler } from './handlers/summarize.js';
import { RagQueryHandler } from './handlers/rag-query.js';
import { RerankHandler } from './handlers/rerank.js';
import { ToolSelectHandler } from './handlers/tool-select.js';
import { SkillSelectHandler } from './handlers/skill-select.js';
import { AssembleHandler } from './handlers/assemble.js';
import { ToolLoopHandler } from './handlers/tool-loop.js';
import { HistoryUpsertHandler } from './handlers/history-upsert.js';

/**
 * DefaultPipeline — minimal, non-extensible pipeline.
 *
 * Queries only `tools` and `history` stores.
 * Writes only `tools` (after MCP connect) and `history` (after response).
 * No plugins. No consumer-defined stores.
 */
export class DefaultPipeline implements IPipeline {
  private deps!: PipelineDeps;

  initialize(deps: PipelineDeps): void {
    this.deps = deps;
  }

  async execute(
    input: string | Message[],
    history: Message[],
    options: CallOptions | undefined,
    yieldChunk: (chunk: Result<LlmStreamChunk, OrchestratorError>) => void,
  ): Promise<PipelineResult> {
    // Build PipelineContext from deps + input
    // Execute stages in order:
    // 1. classify
    // 2. summarize (conditional)
    // 3. parallel: rag-query tools + rag-query history
    // 4. rerank (conditional)
    // 5. skill-select (conditional)
    // 6. tool-select
    // 7. assemble
    // 8. tool-loop (streaming)
    // 9. history-upsert (conditional)
    //
    // Implementation reuses existing handler classes internally.
    // The handlers read/write PipelineContext as before.
    // DefaultPipeline constructs the context with ragStores = { tools, history }
    // filtered from deps.toolsRag / deps.historyRag.
  }
}
```

The actual implementation should reuse `PipelineExecutor` internally or call handlers directly. The key difference from before: `ragStores` only contains `tools` and `history`, and the stage list is hardcoded without `rag-upsert` and without the 3x facts/feedback/state queries.

- [ ] **Step 2: Simplify `PipelineContext`**

In `src/smart-agent/pipeline/context.ts`, remove:
- `shouldRetrieve` flag — DefaultPipeline always queries if stores exist
- `isSapRequired` flag — SAP-specific, not part of agnostic core
- `isAscii` flag — translation is pipeline-specific

These become internal concerns of whichever pipeline implementation needs them.

- [ ] **Step 3: Update `ClassifyHandler`**

In `src/smart-agent/pipeline/handlers/classify.ts`, remove `_updateControlFlags()` method that sets `shouldRetrieve`, `isSapRequired`. The classify handler should only set `ctx.subprompts`.

- [ ] **Step 4: Run lint and build**

Run: `npm run lint && npm run build`
Expected: Errors from handlers that read removed flags — fix references.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement DefaultPipeline as IPipeline (#84)"
```

---

## Task 6: Refactor `build()` to use `IPipeline`

**Files:**
- Modify: `src/smart-agent/builder.ts`
- Modify: `src/smart-agent/agent.ts`

- [ ] **Step 1: Refactor `build()` RAG assembly**

In `src/smart-agent/builder.ts`, replace the current RAG store assembly (lines 638-671) with:

```typescript
// Auto-create tools RAG if MCP clients exist and embedder available
const toolsRag = this._toolsRag ?? (
  this._mcpClients.length > 0 && embedder
    ? new InMemoryRag()  // or VectorRag with embedder
    : undefined
);

// Auto-create history RAG if history summarization enabled
const historyRag = this._historyRag ?? (
  this._agentOverrides.historyAutoSummarizeLimit
    ? new InMemoryRag()
    : undefined
);
```

- [ ] **Step 2: Initialize pipeline with deps**

```typescript
const pipeline = this._pipeline ?? new DefaultPipeline();
pipeline.initialize({
  mainLlm,
  helperLlm,
  classifierLlm,
  mcpClients: this._mcpClients,
  toolsRag,
  historyRag,
  embedder,
  reranker,
  queryExpander,
  // ... other deps
});
```

- [ ] **Step 3: Pass pipeline to SmartAgent**

Add `pipeline: IPipeline` to `SmartAgentDeps`. SmartAgent delegates `streamProcess` to `pipeline.execute()`.

In `src/smart-agent/agent.ts`, update `streamProcess()` to call:
```typescript
const result = await this.deps.pipeline.execute(
  textOrMessages, history, options, yieldChunk
);
```

Remove the direct `PipelineExecutor` usage from SmartAgent.

- [ ] **Step 4: Remove old pipeline fields from builder**

Remove: `withPipeline()` (structured pipeline), `withStageHandler()`, `_pipeline` (structured definition), `_customHandlers`.

- [ ] **Step 5: Remove `SmartAgentRagStores` from `SmartAgentDeps`**

The pipeline owns its stores now. SmartAgent no longer needs `ragStores` directly.

Keep `SmartAgentRagStores` type exported for consumer pipeline implementations that may want it.

- [ ] **Step 6: Tool vectorization — move to pipeline or builder**

The tool vectorization logic (builder.ts lines 719-780) that upserts MCP tools into RAG should stay in builder's `build()` phase, since it happens once at setup time, not per request. It uses `toolsRag` directly:

```typescript
if (toolsRag && embedder && allTools.length > 0) {
  await vectorizeTools(allTools, toolsRag, embedder);
}
```

- [ ] **Step 7: Run lint and build**

Run: `npm run lint && npm run build`
Expected: PASS — full pipeline wiring complete.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire IPipeline into builder and SmartAgent (#84)"
```

---

## Task 7: Remove default stores from SmartServer

**Files:**
- Modify: `src/smart-agent/smart-server.ts`

- [ ] **Step 1: Remove default facts/feedback/state creation**

In `src/smart-agent/smart-server.ts` (lines 366-382), remove:
```typescript
// DELETE this entire block:
if (pipeline?.rag) {
  for (const [key, ragCfg] of Object.entries(pipeline.rag)) {
    if (ragCfg) stores[key] = makeRag(ragCfg, ragOptions);
  }
} else if (this.cfg.rag) {
  const rag = makeRag(this.cfg.rag, ragOptions);
  stores.facts = rag;
  stores.feedback = makeRag({ ...this.cfg.rag }, ragOptions);
  stores.state = makeRag({ ...this.cfg.rag }, ragOptions);
}
```

Replace with DI-style setup:
```typescript
// Create tools RAG from config if rag config exists
const toolsRag = this.cfg.rag ? makeRag(this.cfg.rag, ragOptions) : undefined;
if (toolsRag) builder = builder.setToolsRag(toolsRag);

// Create history RAG if history config exists
const historyRag = this.cfg.rag ? makeRag({ ...this.cfg.rag }, ragOptions) : undefined;
if (historyRag) builder = builder.setHistoryRag(historyRag);
```

- [ ] **Step 2: Remove `builder.withRag(stores)` call**

Remove the call at line 400-402 since `withRag` no longer exists.

- [ ] **Step 3: Remove `withRagUpsert(false)` references if any**

Search SmartServer for any `withRagUpsert` calls and remove them.

- [ ] **Step 4: Run lint and build**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/smart-server.ts
git commit -m "refactor: remove default facts/feedback/state from SmartServer (#84)"
```

---

## Task 8: Add scope-based filtering to RagQueryHandler

**Files:**
- Modify: `src/smart-agent/pipeline/handlers/rag-query.ts`
- Modify: `src/smart-agent/interfaces/types.ts` (update `RagMetadata` if needed)

- [ ] **Step 1: Update `RagQueryHandler` for scope filtering**

The handler should accept scope config and inject appropriate metadata filters:

```typescript
// In rag-query.ts execute():
const scopeFilter: Record<string, unknown> = {};
const scope = config.scope as RagScope | undefined;
if (scope === 'user' && options?.userId) {
  scopeFilter.userId = options.userId;
}
if (scope === 'session' && options?.sessionId) {
  scopeFilter.sessionId = options.sessionId;
}

// Pass filter to query via options
const queryOptions = {
  ...ctx.options,
  ragFilter: { ...ctx.options?.ragFilter, ...scopeFilter },
};
const result = await store.query(ctx.queryEmbedding, k, queryOptions);
```

- [ ] **Step 2: Ensure `CallOptions` supports `userId`**

Check `CallOptions` in `src/smart-agent/interfaces/types.ts`. Add `userId?: string` if not present:

```typescript
export interface CallOptions {
  sessionId?: string;
  userId?: string;
  // ... existing fields
}
```

- [ ] **Step 3: Run lint and build**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/pipeline/handlers/rag-query.ts src/smart-agent/interfaces/types.ts
git commit -m "feat: add scope-based filtering to RagQueryHandler (#84)"
```

---

## Task 9: Remove `rag-upsert` from default pipeline definition and clean up old pipeline DSL

**Files:**
- Modify: `src/smart-agent/pipeline/types.ts`
- Modify: `src/smart-agent/pipeline/default-pipeline.ts` (if old function still exists)
- Modify: `src/index.ts`

- [ ] **Step 1: Clean up `types.ts`**

Remove or deprecate structured pipeline types that are no longer used by core:
- `StructuredPipelineDefinition`
- `StageDefinition` (if only used by old executor)
- `ControlFlowType`

Keep `BuiltInStageType` and `IStageHandler` — consumer pipelines may reuse handlers.

- [ ] **Step 2: Remove old `getDefaultPipelineDefinition()` function**

If it still exists alongside the new `DefaultPipeline` class, delete it and `getDefaultStages()`.

- [ ] **Step 3: Update `src/index.ts` exports**

Remove exports for deleted types/functions:
```typescript
// Remove:
export { getDefaultPipelineDefinition, getDefaultStages } from ...
export type { StructuredPipelineDefinition } from ...
```

Add exports for new types:
```typescript
export { DefaultPipeline } from './smart-agent/pipeline/default-pipeline.js';
```

- [ ] **Step 4: Run lint and build**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove structured pipeline DSL from core, export DefaultPipeline (#84)"
```

---

## Task 10: Add session cleanup to in-memory RAG implementations

**Files:**
- Modify: `src/smart-agent/rag/in-memory-rag.ts` (or wherever InMemoryRag lives)
- Modify: `src/smart-agent/rag/vector-rag.ts`

- [ ] **Step 1: Add `clear()` method to `IRag`**

In `src/smart-agent/interfaces/rag.ts`, add optional cleanup method:

```typescript
export interface IRag {
  upsert(...): Promise<Result<void, RagError>>;
  query(...): Promise<Result<RagResult[], RagError>>;
  healthCheck(...): Promise<Result<void, RagError>>;
  /** Clear all records. Used for session-scoped store cleanup. */
  clear?(): void;
}
```

- [ ] **Step 2: Implement `clear()` in InMemoryRag**

```typescript
// In InMemoryRag
clear(): void {
  this.records.length = 0;
}
```

- [ ] **Step 3: Implement `clear()` in VectorRag**

```typescript
// In VectorRag
clear(): void {
  this.records.length = 0;
  this.invertedIndex.clear();
}
```

- [ ] **Step 4: Run lint and build**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/interfaces/rag.ts src/smart-agent/rag/in-memory-rag.ts src/smart-agent/rag/vector-rag.ts
git commit -m "feat: add clear() to IRag for session cleanup (#84)"
```

---

## Task 11: Update exports and final cleanup

**Files:**
- Modify: `src/index.ts`
- Modify: `src/smart-agent/builder.ts` (remove dead code)

- [ ] **Step 1: Final export audit**

Verify `src/index.ts` exports:
- `IPipeline`, `PipelineDeps`, `PipelineResult` — exported
- `DefaultPipeline` — exported
- `ISmartAgentPlugin`, `IRagStoreConfig`, `RagScope` — exported
- `SmartAgentRagStores` — still exported (consumers may use)
- Removed: `getDefaultPipelineDefinition`, `getDefaultStages`, `StructuredPipelineDefinition`
- Removed: `RagUpsertHandler` export

- [ ] **Step 2: Remove dead code from builder**

Search for any remaining references to removed methods/fields in builder.ts:
- `_ragStores` field
- `_customHandlers` map
- `withPipeline()` (old structured)
- `withStageHandler()`
- Circuit breaker wrapping of `ragStores` (refactor to wrap toolsRag/historyRag individually)

- [ ] **Step 3: Run full build and lint**

Run: `npm run lint && npm run build`
Expected: PASS — zero errors.

- [ ] **Step 4: Smoke test**

Run: `npm run test`
Expected: Build succeeds and basic smoke test passes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: final cleanup — remove dead code, update exports (#84)"
```

---

## Task 12: Update documentation

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/QUICK_START.md`
- Modify: `docs/EXAMPLES.md`

- [ ] **Step 1: Update ARCHITECTURE.md**

Update the pipeline section to describe the new two-level architecture:
- Builder = global DI
- IPipeline = request orchestration
- DefaultPipeline = tools + history only
- Consumer pipelines with plugins for custom stores

Remove references to facts/feedback/state stores, structured pipeline DSL, YAML stage definitions.

- [ ] **Step 2: Update QUICK_START.md**

Update builder examples to use new API:
```typescript
builder
  .setLlm(llm)
  .setMcpClients([mcp])
  .setPipeline(new DefaultPipeline())
  .build();
```

- [ ] **Step 3: Update EXAMPLES.md**

Add consumer-defined pipeline example with plugin. Remove examples referencing `withRag()`, `withRagUpsert()`.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: update architecture and examples for consumer-defined RAG (#84)"
```
