# IRequestLogger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-model, per-component usage tracking via `IRequestLogger` interface, replacing the mixed-token `TokenCountingLlm` approach.

**Architecture:** New `IRequestLogger` interface injected into SmartAgent and PipelineContext. Pipeline stages explicitly log LLM calls, RAG queries, and tool calls. `DefaultRequestLogger` aggregates entries; `NoopRequestLogger` for opt-out. `SmartAgentHandle.getUsage()` replaced by `handle.requestLogger`.

**Tech Stack:** TypeScript, ESM, Biome lint

**Spec:** `docs/superpowers/specs/2026-04-05-request-logger-design.md`

---

### Task 1: IRequestLogger Interface and Entry Types

**Files:**
- Create: `src/smart-agent/interfaces/request-logger.ts`

- [ ] **Step 1: Create interface file**

```ts
// src/smart-agent/interfaces/request-logger.ts

export type LlmComponent =
  | 'tool-loop'
  | 'classifier'
  | 'helper'
  | 'translate'
  | 'query-expander';

export interface LlmCallEntry {
  component: LlmComponent;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

export interface RagQueryEntry {
  store: string;
  query: string;
  resultCount: number;
  durationMs: number;
}

export interface ToolCallEntry {
  toolName: string;
  success: boolean;
  durationMs: number;
  cached: boolean;
}

export interface RequestSummary {
  /** Per-model aggregated token usage. */
  byModel: Record<
    string,
    {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      requests: number;
    }
  >;
  /** Per-component aggregated token usage. */
  byComponent: Record<
    string,
    {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      requests: number;
    }
  >;
  ragQueries: number;
  toolCalls: number;
  /** Wall-clock time for the entire request. */
  totalDurationMs: number;
}

export interface IRequestLogger {
  logLlmCall(entry: LlmCallEntry): void;
  logRagQuery(entry: RagQueryEntry): void;
  logToolCall(entry: ToolCallEntry): void;
  /** Mark the start of a request for wall-clock duration tracking. */
  startRequest(): void;
  /** Mark the end of a request for wall-clock duration tracking. */
  endRequest(): void;
  getSummary(): RequestSummary;
  reset(): void;
}
```

- [ ] **Step 2: Lint check**

Run: `npx biome check src/smart-agent/interfaces/request-logger.ts`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/smart-agent/interfaces/request-logger.ts
git commit -m "feat: add IRequestLogger interface and entry types"
```

---

### Task 2: DefaultRequestLogger and NoopRequestLogger

**Files:**
- Create: `src/smart-agent/logger/default-request-logger.ts`
- Create: `src/smart-agent/logger/noop-request-logger.ts`

- [ ] **Step 1: Create DefaultRequestLogger**

```ts
// src/smart-agent/logger/default-request-logger.ts

import type {
  IRequestLogger,
  LlmCallEntry,
  RagQueryEntry,
  RequestSummary,
  ToolCallEntry,
} from '../interfaces/request-logger.js';

export class DefaultRequestLogger implements IRequestLogger {
  private llmCalls: LlmCallEntry[] = [];
  private ragQueryEntries: RagQueryEntry[] = [];
  private toolCallEntries: ToolCallEntry[] = [];
  private requestStartMs = 0;
  private requestDurationMs = 0;

  /** Call at the start of each request to begin wall-clock tracking. */
  startRequest(): void {
    this.requestStartMs = Date.now();
  }

  /** Call at the end of each request to finalize wall-clock duration. */
  endRequest(): void {
    this.requestDurationMs = this.requestStartMs
      ? Date.now() - this.requestStartMs
      : 0;
  }

  logLlmCall(entry: LlmCallEntry): void {
    this.llmCalls.push(entry);
  }

  logRagQuery(entry: RagQueryEntry): void {
    this.ragQueryEntries.push(entry);
  }

  logToolCall(entry: ToolCallEntry): void {
    this.toolCallEntries.push(entry);
  }

  getSummary(): RequestSummary {
    const byModel: RequestSummary['byModel'] = {};
    const byComponent: RequestSummary['byComponent'] = {};

    for (const call of this.llmCalls) {
      // Aggregate by model
      if (!byModel[call.model]) {
        byModel[call.model] = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          requests: 0,
        };
      }
      const m = byModel[call.model];
      m.promptTokens += call.promptTokens;
      m.completionTokens += call.completionTokens;
      m.totalTokens += call.totalTokens;
      m.requests++;

      // Aggregate by component
      if (!byComponent[call.component]) {
        byComponent[call.component] = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          requests: 0,
        };
      }
      const c = byComponent[call.component];
      c.promptTokens += call.promptTokens;
      c.completionTokens += call.completionTokens;
      c.totalTokens += call.totalTokens;
      c.requests++;
    }

    return {
      byModel,
      byComponent,
      ragQueries: this.ragQueryEntries.length,
      toolCalls: this.toolCallEntries.length,
      totalDurationMs: this.requestDurationMs,
    };
  }

  reset(): void {
    this.llmCalls = [];
    this.ragQueryEntries = [];
    this.toolCallEntries = [];
    this.requestStartMs = 0;
    this.requestDurationMs = 0;
  }
}
```

- [ ] **Step 2: Create NoopRequestLogger**

```ts
// src/smart-agent/logger/noop-request-logger.ts

import type {
  IRequestLogger,
  LlmCallEntry,
  RagQueryEntry,
  RequestSummary,
  ToolCallEntry,
} from '../interfaces/request-logger.js';

const EMPTY_SUMMARY: RequestSummary = {
  byModel: {},
  byComponent: {},
  ragQueries: 0,
  toolCalls: 0,
  totalDurationMs: 0,
};

export class NoopRequestLogger implements IRequestLogger {
  logLlmCall(_entry: LlmCallEntry): void {}
  logRagQuery(_entry: RagQueryEntry): void {}
  logToolCall(_entry: ToolCallEntry): void {}
  startRequest(): void {}
  endRequest(): void {}
  getSummary(): RequestSummary {
    return { ...EMPTY_SUMMARY, byModel: {}, byComponent: {} };
  }
  reset(): void {}
}
```

- [ ] **Step 3: Lint check**

Run: `npx biome check src/smart-agent/logger/default-request-logger.ts src/smart-agent/logger/noop-request-logger.ts`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/logger/default-request-logger.ts src/smart-agent/logger/noop-request-logger.ts
git commit -m "feat: add DefaultRequestLogger and NoopRequestLogger"
```

---

### Task 3: Add `model` Property to ILlm and Implementations

**Files:**
- Modify: `src/smart-agent/interfaces/llm.ts` — add `readonly model?: string`
- Modify: `src/smart-agent/adapters/llm-adapter.ts` — expose `model` getter
- Modify: `src/smart-agent/resilience/retry-llm.ts` — pass through `model`
- Modify: `src/smart-agent/resilience/circuit-breaker-llm.ts` — pass through `model`

- [ ] **Step 1: Add `model` to ILlm interface**

In `src/smart-agent/interfaces/llm.ts`, add to the `ILlm` interface:

```ts
  /** Model identifier used for usage tracking. */
  readonly model?: string;
```

- [ ] **Step 2: Expose `model` getter in LlmAdapter**

In `src/smart-agent/adapters/llm-adapter.ts`, the class already has `getModel()` method (line 260). Add a `model` getter that delegates to it:

```ts
  get model(): string {
    return this.getModel();
  }
```

- [ ] **Step 3: Pass through `model` in RetryLlm**

In `src/smart-agent/resilience/retry-llm.ts`, the class wraps an `ILlm` as `this.inner`. Add:

```ts
  get model(): string | undefined {
    return this.inner.model;
  }
```

- [ ] **Step 4: Pass through `model` in CircuitBreakerLlm**

In `src/smart-agent/resilience/circuit-breaker-llm.ts`, the class wraps an `ILlm` as `this.inner`. Add:

```ts
  get model(): string | undefined {
    return this.inner.model;
  }
```

- [ ] **Step 5: Lint check**

Run: `npx biome check src/smart-agent/interfaces/llm.ts src/smart-agent/adapters/llm-adapter.ts src/smart-agent/resilience/retry-llm.ts src/smart-agent/resilience/circuit-breaker-llm.ts`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/interfaces/llm.ts src/smart-agent/adapters/llm-adapter.ts src/smart-agent/resilience/retry-llm.ts src/smart-agent/resilience/circuit-breaker-llm.ts
git commit -m "feat: add model property to ILlm and decorator pass-through"
```

---

### Task 4: Inject IRequestLogger into SmartAgent and PipelineContext

**Files:**
- Modify: `src/smart-agent/pipeline/context.ts` — add `requestLogger` field
- Modify: `src/smart-agent/agent.ts` — add `requestLogger` to `SmartAgentDeps`, wire into PipelineContext, log `_summarizeHistory`

- [ ] **Step 1: Add `requestLogger` to PipelineContext**

In `src/smart-agent/pipeline/context.ts`:

1. Add import:
```ts
import type { IRequestLogger } from '../interfaces/request-logger.js';
```

2. Add to the dependencies section (after `readonly logger: ILogger | undefined;`):
```ts
  readonly requestLogger: IRequestLogger;
```

- [ ] **Step 2: Add `requestLogger` to SmartAgentDeps**

In `src/smart-agent/agent.ts`:

1. Add import:
```ts
import type { IRequestLogger } from './interfaces/request-logger.js';
import { NoopRequestLogger } from './logger/noop-request-logger.js';
```

2. Add to `SmartAgentDeps` interface (after `logger?: ILogger;`):
```ts
  requestLogger?: IRequestLogger;
```

3. Add field to `SmartAgent` class (alongside other private fields near line 182):
```ts
  private readonly requestLogger: IRequestLogger;
```

4. In the constructor (after line 199), initialize:
```ts
  this.requestLogger = deps.requestLogger ?? new NoopRequestLogger();
```

- [ ] **Step 3: Wire requestLogger into PipelineContext**

In `src/smart-agent/agent.ts`, in the `_runStructuredPipeline` method where `ctx: PipelineContext` is created (around line 1659), add after the `logger` line:

```ts
      requestLogger: this.requestLogger,
```

- [ ] **Step 4: Call `startRequest()`/`endRequest()` for wall-clock tracking**

In `agent.ts`, in `process()` call `this.requestLogger.startRequest()` at the beginning and `this.requestLogger.endRequest()` before returning. Similarly in `streamProcess()` — `startRequest()` at entry, `endRequest()` when the generator completes. This provides wall-clock duration for `getSummary().totalDurationMs`.

- [ ] **Step 5: Log `_summarizeHistory` helper LLM call**

In `src/smart-agent/agent.ts`, in `_summarizeHistory` method (line 1589), wrap the `helperLlm.chat()` call with timing and logging:

Replace the call at line 1599-1609:
```ts
    const start = Date.now();
    const res = await this.deps.helperLlm.chat(
      [
        ...toS,
        {
          role: 'system' as const,
          content: this.config.historySummaryPrompt || dp,
        },
      ],
      [],
      opts,
    );
    this.requestLogger.logLlmCall({
      component: 'helper',
      model: this.deps.helperLlm.model ?? 'unknown',
      promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
      completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
      totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
      durationMs: Date.now() - start,
    });
```

- [ ] **Step 6: Build check**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 7: Commit**

```bash
git add src/smart-agent/pipeline/context.ts src/smart-agent/agent.ts
git commit -m "feat: inject IRequestLogger into SmartAgent and PipelineContext"
```

---

### Task 5: Log LLM Calls and Tool Calls in ToolLoopHandler

**Files:**
- Modify: `src/smart-agent/pipeline/handlers/tool-loop.ts`

- [ ] **Step 1: Log LLM calls after each streamChat iteration**

In `tool-loop.ts`, after the streaming loop completes and `llmCallDuration` is computed (around line 397-402), add:

```ts
      ctx.requestLogger.logLlmCall({
        component: 'tool-loop',
        model: ctx.mainLlm.model ?? 'unknown',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        durationMs: llmCallDuration,
      });
```

Note: Per-iteration token counts come from streaming chunks. We need to track them per-iteration. Add local accumulators at the start of each for-loop iteration (inside `for (let iteration = 0; ...)`), before the `streamChat` call (around line 324). These must be reset each iteration:

```ts
      let iterPromptTokens = 0;
      let iterCompletionTokens = 0;
      let iterTotalTokens = 0;
```

Inside the `if (chunk.usage)` block (around line 387-392), also accumulate:

```ts
          iterPromptTokens += chunk.usage.promptTokens;
          iterCompletionTokens += chunk.usage.completionTokens;
          iterTotalTokens += chunk.usage.totalTokens;
```

Then update the logLlmCall to use these:

```ts
      ctx.requestLogger.logLlmCall({
        component: 'tool-loop',
        model: ctx.mainLlm.model ?? 'unknown',
        promptTokens: iterPromptTokens,
        completionTokens: iterCompletionTokens,
        totalTokens: iterTotalTokens,
        durationMs: llmCallDuration,
      });
```

- [ ] **Step 2: Log tool calls after execution**

In `tool-loop.ts`, in the results processing loop (around line 719 where `toolCallCount++` happens), add after the increment:

```ts
        ctx.requestLogger.logToolCall({
          toolName: tc.name,
          success: res.ok,
          durationMs: duration,
          cached: !!ctx.toolCache.get(tc.name, tc.arguments),
        });
```

We need to track `cached` at execution time. The `ToolExecResult` type (line 626-634) needs a `cached` field:

```ts
      type ToolExecResult = {
        tc: { id: string; name: string; arguments: Record<string, unknown> };
        text: string;
        res: Result<
          { content: string | Record<string, unknown>; isError?: boolean },
          { message: string }
        > | null;
        duration: number;
        cached: boolean;
      };
```

In the tool execution promise (line 636-676), the code uses a ternary for cached vs fresh. Both branches must include the `cached` field in the returned object:

- Cached branch (the IIFE at line 649-654): add `cached: true` to the return
- Fresh branch (the async IIFE at line 655-663): add `cached: false` to the return
- Also add `cached: false` to the final return `{ tc, text: '', res: null, duration: 0, cached: false }` at line 643

Then in the results processing loop (around line 736 where `toolCallCount++`), add:

```ts
        ctx.requestLogger.logToolCall({
          toolName: tc.name,
          success: !!res?.ok,
          durationMs: r.duration,
          cached: r.cached,
        });
```

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/pipeline/handlers/tool-loop.ts
git commit -m "feat: log LLM calls and tool calls in ToolLoopHandler"
```

---

### Task 6: Log Classifier, Translate, Summarize, and QueryExpander LLM Calls

**Files:**
- Modify: `src/smart-agent/classifier/llm-classifier.ts`
- Modify: `src/smart-agent/pipeline/handlers/translate.ts`
- Modify: `src/smart-agent/pipeline/handlers/summarize.ts`
- Modify: `src/smart-agent/rag/query-expander.ts`

- [ ] **Step 1: Log classifier LLM call**

In `src/smart-agent/classifier/llm-classifier.ts`:

1. The class currently has `private readonly llm: ILlm` and calls `this.llm.chat()` at line 140. The classifier doesn't have access to `IRequestLogger` directly.

2. Add `IRequestLogger` as an optional constructor dependency:

```ts
import type { IRequestLogger } from '../interfaces/request-logger.js';

// In constructor (add requestLogger as third optional param, keep config optional):
constructor(
  private readonly llm: ILlm,
  config?: LlmClassifierConfig,
  private readonly requestLogger?: IRequestLogger,
) {
```

3. Wrap the `chat()` call at line 140 with timing and logging:

```ts
    const start = Date.now();
    const result = await this.llm.chat(messages, [], options);
    if (this.requestLogger) {
      this.requestLogger.logLlmCall({
        component: 'classifier',
        model: this.llm.model ?? 'unknown',
        promptTokens: result.ok ? (result.value.usage?.promptTokens ?? 0) : 0,
        completionTokens: result.ok ? (result.value.usage?.completionTokens ?? 0) : 0,
        totalTokens: result.ok ? (result.value.usage?.totalTokens ?? 0) : 0,
        durationMs: Date.now() - start,
      });
    }
```

- [ ] **Step 2: Log translate LLM call**

In `src/smart-agent/pipeline/handlers/translate.ts`:

The handler uses `ctx.helperLlm || ctx.mainLlm` and calls `.chat()` at line 42. Add logging after the call:

```ts
    const llm = ctx.helperLlm || ctx.mainLlm;
    const start = Date.now();
    const res = await llm.chat(/* existing args */);
    ctx.requestLogger.logLlmCall({
      component: 'translate',
      model: llm.model ?? 'unknown',
      promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
      completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
      totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
      durationMs: Date.now() - start,
    });
```

- [ ] **Step 3: Log summarize LLM call**

In `src/smart-agent/pipeline/handlers/summarize.ts`:

The handler calls `ctx.helperLlm.chat()` at line 45. Add logging after:

```ts
    const start = Date.now();
    const res = await ctx.helperLlm.chat(/* existing args */);
    ctx.requestLogger.logLlmCall({
      component: 'helper',
      model: ctx.helperLlm.model ?? 'unknown',
      promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
      completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
      totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
      durationMs: Date.now() - start,
    });
```

- [ ] **Step 4: Log query expander LLM call**

In `src/smart-agent/rag/query-expander.ts`:

The `LlmQueryExpander` class calls `this.llm.chat()` at line 35. It doesn't have access to `IRequestLogger`. Add optional dependency:

```ts
import type { IRequestLogger } from '../interfaces/request-logger.js';

// In constructor:
constructor(
  private readonly llm: ILlm,
  private readonly requestLogger?: IRequestLogger,
) {}
```

Wrap the `chat()` call with timing and logging:

```ts
    const start = Date.now();
    const res = await this.llm.chat(/* existing args */);
    if (this.requestLogger) {
      this.requestLogger.logLlmCall({
        component: 'query-expander',
        model: this.llm.model ?? 'unknown',
        promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
        completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
        totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
        durationMs: Date.now() - start,
      });
    }
```

- [ ] **Step 5: Build check**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/classifier/llm-classifier.ts src/smart-agent/pipeline/handlers/translate.ts src/smart-agent/pipeline/handlers/summarize.ts src/smart-agent/rag/query-expander.ts
git commit -m "feat: log LLM calls in classifier, translate, summarize, query-expander"
```

---

### Task 7: Log RAG Queries

**Files:**
- Modify: `src/smart-agent/pipeline/handlers/tool-loop.ts` — log RAG query in tool reselect
- Check: pipeline RAG stage handlers for RAG query logging points

- [ ] **Step 1: Identify all RAG query points**

Search for `ragStores` or `.query(` calls across pipeline handlers. The main points are:
1. Tool-loop reselect (tool-loop.ts, around line 238)
2. Pipeline `rag-query` handler (if it exists as a separate stage handler)

Read the rag-query handler file to confirm.

- [ ] **Step 2: Log RAG query in tool-loop reselect**

In `tool-loop.ts`, after the `ctx.ragStores.tools.query()` call (around line 238), add:

```ts
            ctx.requestLogger.logRagQuery({
              store: 'tools',
              query: reSelectQuery.slice(0, 200),
              resultCount: ragResult.ok ? ragResult.value.length : 0,
              durationMs: /* track duration around the query call */,
            });
```

Wrap the RAG query with timing:
```ts
            const ragStart = Date.now();
            const ragResult = await ctx.ragStores.tools.query(/* existing args */);
            ctx.requestLogger.logRagQuery({
              store: 'tools',
              query: reSelectQuery.slice(0, 200),
              resultCount: ragResult.ok ? ragResult.value.length : 0,
              durationMs: Date.now() - ragStart,
            });
```

- [ ] **Step 3: Log RAG queries in pipeline rag-query handler**

In `src/smart-agent/pipeline/handlers/rag-query.ts`, wrap the `store.query()` call (line 53) with timing:

```ts
    const ragStart = Date.now();
    const result = await store.query(ctx.queryEmbedding, k, ctx.options);
    ctx.requestLogger.logRagQuery({
      store: storeName,
      query: ctx.ragText.slice(0, 200),
      resultCount: result.ok ? result.value.length : 0,
      durationMs: Date.now() - ragStart,
    });
```

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/pipeline/handlers/tool-loop.ts src/smart-agent/pipeline/handlers/rag-query.ts
git commit -m "feat: log RAG queries via IRequestLogger"
```

---

### Task 8: Wire IRequestLogger into Builder and SmartAgentHandle

**Files:**
- Modify: `src/smart-agent/builder.ts`

- [ ] **Step 1: Add `_requestLogger` field and `withRequestLogger()` method**

In `src/smart-agent/builder.ts`:

1. Add imports:
```ts
import type { IRequestLogger } from './interfaces/request-logger.js';
import { DefaultRequestLogger } from './logger/default-request-logger.js';
```

2. Add field (near line 178, alongside other private fields):
```ts
  private _requestLogger?: IRequestLogger;
```

3. Add fluent setter (near the other `withXxx` methods):
```ts
  /** Set a request logger for per-model usage tracking. */
  withRequestLogger(logger: IRequestLogger): this {
    this._requestLogger = logger;
    return this;
  }
```

- [ ] **Step 2: Create requestLogger in build() and pass to SmartAgent**

In `build()` method, before the `new SmartAgent(...)` call (around line 780):

```ts
    const requestLogger = this._requestLogger ?? new DefaultRequestLogger();
```

Add `requestLogger` to the SmartAgent deps object:
```ts
      ...(requestLogger ? { requestLogger } : {}),
```

- [ ] **Step 3: Pass requestLogger to LlmClassifier and LlmQueryExpander**

In `build()`, where classifier is created (around line 697):
```ts
    const classifier: ISubpromptClassifier =
      this._classifier ?? new LlmClassifier(classifierLlm, classifierCfg, requestLogger);
```

If query expander is `LlmQueryExpander`, pass requestLogger. This depends on how `_queryExpander` is set — if it comes from plugins, we can't inject. Only inject when builder creates it. Check if builder ever creates LlmQueryExpander directly — if not, skip this (plugin-loaded expanders handle their own logging).

- [ ] **Step 4: Replace `getUsage` with `requestLogger` in SmartAgentHandle**

In the return statement of `build()` (around line 848):

1. Remove the `getUsage` line:
```ts
      // REMOVE: getUsage: this._getUsage ?? (() => zeroUsage),
```

2. Add `requestLogger`:
```ts
      requestLogger,
```

3. Update the `SmartAgentHandle` interface (around line 113):

Remove:
```ts
  getUsage(): TokenUsage;
```

Add:
```ts
  /** Request logger for per-model usage tracking. */
  requestLogger: IRequestLogger;
```

4. Remove `_getUsage` field (line 178), `withUsageProvider()` method (lines 349-352), and `zeroUsage` const (lines 816-821).

5. Remove `TokenCountingLlm` import (line 42) and `TokenUsage` type import.

- [ ] **Step 5: Remove `TokenCountingLlm` unwrapping in model provider auto-detection**

In `build()` (around line 826-829), simplify:
```ts
    // BEFORE:
    // const candidate = mainLlm instanceof TokenCountingLlm ? mainLlm.wrappedLlm : mainLlm;
    // AFTER:
    const candidate = mainLlm;
    if (isModelProvider(candidate)) {
      modelProvider = candidate;
    }
```

- [ ] **Step 6: Build check**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 7: Commit**

```bash
git add src/smart-agent/builder.ts
git commit -m "feat: wire IRequestLogger into builder and SmartAgentHandle"
```

---

### Task 9: Remove TokenCountingLlm and Update Providers

**Files:**
- Remove: `src/smart-agent/llm/token-counting-llm.ts`
- Modify: `src/smart-agent/providers.ts` — remove TokenCountingLlm wrapping
- Modify: `src/index.ts` — remove TokenCountingLlm export, add IRequestLogger exports

- [ ] **Step 1: Update providers.ts**

In `src/smart-agent/providers.ts`:

1. Remove the `TokenCountingLlm` import.
2. Change return type of `makeLlm()` from `TokenCountingLlm` to `ILlm`.
3. Change return type of `makeDefaultLlm()` from `TokenCountingLlm` to `ILlm`.
4. In each provider case, replace `new TokenCountingLlm(new LlmAdapter(...))` with just `new LlmAdapter(...)`.

- [ ] **Step 2: Delete token-counting-llm.ts**

```bash
rm src/smart-agent/llm/token-counting-llm.ts
```

- [ ] **Step 3: Update index.ts exports**

In `src/index.ts`:

1. `TokenCountingLlm` and `TokenUsage` are NOT currently exported from `index.ts`, so no removal needed.
2. Add new exports:
```ts
export type {
  IRequestLogger,
  LlmCallEntry,
  RagQueryEntry,
  ToolCallEntry,
  RequestSummary,
  LlmComponent,
} from './smart-agent/interfaces/request-logger.js';
export { DefaultRequestLogger } from './smart-agent/logger/default-request-logger.js';
export { NoopRequestLogger } from './smart-agent/logger/noop-request-logger.js';
```

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: compiles without errors. Fix any remaining references to `TokenCountingLlm` or `TokenUsage`.

- [ ] **Step 5: Commit**

```bash
git rm src/smart-agent/llm/token-counting-llm.ts
git add src/smart-agent/providers.ts src/index.ts
git commit -m "refactor: remove TokenCountingLlm, export IRequestLogger types"
```

---

### Task 10: Migrate SmartServer

**Files:**
- Modify: `src/smart-agent/smart-server.ts`

- [ ] **Step 1: Replace TokenUsage with IRequestLogger throughout smart-server.ts**

All touch points (found via grep):

| Line | Current | Change to |
|------|---------|-----------|
| 27 | `import type { TokenUsage } from './llm/token-counting-llm.js';` | `import type { IRequestLogger } from './interfaces/request-logger.js';` |
| 180 | `getUsage(): TokenUsage;` in `SmartServerHandle` | `requestLogger: IRequestLogger;` |
| 313-315 | `const getUsage = (): TokenUsage => { ... }` aggregating `mainLlm.getUsage()` + `classifierLlm.getUsage()` | Remove entirely — use `builderHandle.requestLogger` instead |
| 387 | `.withUsageProvider(getUsage)` | Remove (builder no longer has `withUsageProvider`) |
| 587, 620, 710 | Passing `getUsage` to helper functions | Pass `builderHandle.requestLogger` instead |
| 629, 797 | Function params `getUsage: () => TokenUsage` | Change to `requestLogger: IRequestLogger` |
| 676 | `res.end(JSON.stringify(getUsage()));` | `res.end(JSON.stringify(requestLogger.getSummary()));` |

The key change: instead of creating a `getUsage` function that calls `.getUsage()` on `TokenCountingLlm` instances, pass `builderHandle.requestLogger` through to all consumers. The builder handle now exposes `requestLogger` directly.

- [ ] **Step 2: Update SmartServerHandle return**

In the `start()` method where `SmartServerHandle` is returned, replace `getUsage` with `requestLogger: builderHandle.requestLogger`.

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/smart-server.ts
git commit -m "refactor: migrate SmartServer from getUsage() to IRequestLogger"
```

---

### Task 11: Full Build and Lint Validation

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: success with no TypeScript errors

- [ ] **Step 2: Lint check**

Run: `npm run lint:check`
Expected: no new errors (existing warnings may remain)

- [ ] **Step 3: Smoke test**

Run: `npm run test`
Expected: build + start succeeds

- [ ] **Step 4: Search for stale references**

Search codebase for any remaining references to `TokenCountingLlm`, `TokenUsage`, `getUsage`, or `withUsageProvider` that should have been cleaned up.

Run: `grep -rn 'TokenCountingLlm\|TokenUsage\|getUsage\|withUsageProvider' src/`
Expected: no matches (or only in test files that need updating)

- [ ] **Step 5: Fix any remaining issues and commit**

```bash
git add -A
git commit -m "chore: clean up stale TokenCountingLlm references"
```
