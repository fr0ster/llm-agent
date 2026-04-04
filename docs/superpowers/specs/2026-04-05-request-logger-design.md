# Request Logger — Per-Model Usage Tracking

**Date:** 2026-04-05

## Problem

SmartAgent returns aggregated token usage (`SmartAgentResponse.usage` and `SmartAgentHandle.getUsage()`) as a single sum across all LLM calls. Since different components (tool-loop, classifier, helper, translate) may use different models, mixing tokens is not useful for billing or analytics.

Consumers need:
1. **Main LLM tokens only** in `SmartAgentResponse.usage` (the "cost of this response")
2. **Detailed per-model, per-component breakdown** via an injectable logger interface

## Solution

Introduce `IRequestLogger` — a new interface separate from the existing `ILogger` (which handles operational/debug events). `IRequestLogger` is responsible for usage analytics: LLM calls, RAG queries, and tool calls with model attribution.

### Separation from `ILogger`

| Concern | Interface | Purpose |
|---------|-----------|---------|
| Operations/debug | `ILogger` | Pipeline events (classify, rag_query, llm_call timing) |
| Usage analytics | `IRequestLogger` | Per-model token tracking, RAG/tool stats, billing |

## API

### Entry Types

```ts
type LlmComponent =
  | 'tool-loop'
  | 'classifier'
  | 'helper'
  | 'translate'
  | 'query-expander';

interface LlmCallEntry {
  component: LlmComponent;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

interface RagQueryEntry {
  store: string;
  query: string;
  resultCount: number;
  durationMs: number;
}

interface ToolCallEntry {
  toolName: string;
  success: boolean;
  durationMs: number;
  cached: boolean;
}
```

### Summary Type

```ts
interface RequestSummary {
  byModel: Record<string, {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requests: number;
  }>;
  byComponent: Record<string, {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requests: number;
  }>;
  ragQueries: number;
  toolCalls: number;
  /** Wall-clock time for the entire request (not sum of individual durations). */
  totalDurationMs: number;
}
```

### Interface

```ts
interface IRequestLogger {
  logLlmCall(entry: LlmCallEntry): void;
  logRagQuery(entry: RagQueryEntry): void;
  logToolCall(entry: ToolCallEntry): void;
  getSummary(): RequestSummary;
  reset(): void;
}
```

## ILlm.model

Each `ILlm` implementation exposes its model name via an optional readonly property:

```ts
interface ILlm {
  // ... existing methods
  readonly model?: string;
}
```

All existing adapters (OpenAI, Anthropic, DeepSeek, SapCoreAI) already hold model name internally — they just need to expose it. Fallback in log entries: `'unknown'`.

Decorator wrappers (`RetryLlm`, `CircuitBreakerLlm`, `TokenCountingLlm`) must pass through `model` from the inner ILlm during migration (before `TokenCountingLlm` is removed).

## Implementations

### DefaultRequestLogger

Stores raw entries in arrays. `getSummary()` aggregates on demand (grouped by model and by component). This is the default when no custom logger is injected.

### NoopRequestLogger

Empty methods, empty summary. For consumers who don't need usage tracking.

## Builder Integration

```ts
class SmartAgentBuilder {
  withRequestLogger(logger: IRequestLogger): this;
  // build() creates DefaultRequestLogger if not set
}
```

## SmartAgentHandle Changes

```ts
interface SmartAgentHandle {
  // REMOVED: getUsage(): TokenUsage
  // ADDED:
  requestLogger: IRequestLogger;
  // ... rest unchanged
}
```

Consumers call `handle.requestLogger.getSummary()` for detailed breakdown.

## SmartAgentResponse.usage

Unchanged type. Populated only from tool-loop LLM calls (main LLM). This is already the current behavior — tool-loop is the only handler that yields usage chunks via `streamProcess()`.

## Pipeline Integration Points

| Location | Method | Details |
|----------|--------|---------|
| `tool-loop.ts` — after each `streamChat` | `logLlmCall` | component: `'tool-loop'`, model from `ctx.mainLlm.model` |
| `tool-loop.ts` — after each tool execution | `logToolCall` | toolName, success, duration, cached (MCP tool cache) |
| `llm-classifier.ts` — after `llm.chat()` | `logLlmCall` | component: `'classifier'` |
| `translate.ts` — after translation call | `logLlmCall` | component: `'translate'` |
| `summarize.ts` — after `helperLlm.chat()` | `logLlmCall` | component: `'helper'` |
| `agent.ts` — after `_summarizeHistory()` | `logLlmCall` | component: `'helper'` (non-pipeline path) |
| `query-expander.ts` — after `llm.chat()` | `logLlmCall` | component: `'query-expander'` |
| RAG query points (tool-loop reselect, pipeline rag stage) | `logRagQuery` | store, query, resultCount |

When `LlmResponse.usage` is absent (provider did not return usage), tokens default to 0.

`IRequestLogger` is injected into `PipelineContext` alongside existing `logger`, `metrics`, `tracer`.

## Breaking Changes

- `SmartAgentHandle.getUsage()` removed — replaced by `handle.requestLogger.getSummary()`
- `TokenCountingLlm` removed as redundant
- `withUsageProvider()` builder method removed
- `makeLlm()` / `makeDefaultLlm()` in `providers.ts` return `ILlm` instead of `TokenCountingLlm`
- `SmartServerHandle.getUsage()` migrated to use `IRequestLogger`; `/v1/usage` endpoint returns `RequestSummary`

## Files

| File | Action |
|------|--------|
| `src/smart-agent/interfaces/request-logger.ts` | New — interface + entry types |
| `src/smart-agent/logger/default-request-logger.ts` | New — default implementation |
| `src/smart-agent/logger/noop-request-logger.ts` | New — noop implementation |
| `src/smart-agent/interfaces/llm.ts` | Modify — add `model?: string` |
| `src/smart-agent/builder.ts` | Modify — `withRequestLogger()`, wire into agent, replace `getUsage` |
| `src/smart-agent/agent.ts` | Modify — inject requestLogger, log helper calls |
| `src/smart-agent/pipeline/context.ts` | Modify — add `requestLogger` field |
| `src/smart-agent/pipeline/handlers/tool-loop.ts` | Modify — log LLM calls and tool calls |
| `src/smart-agent/classifier/llm-classifier.ts` | Modify — log classifier LLM call |
| `src/smart-agent/pipeline/handlers/translate.ts` | Modify — log translation LLM call |
| `src/smart-agent/pipeline/handlers/summarize.ts` | Modify — log helper LLM call |
| `src/smart-agent/rag/query-expander.ts` | Modify — log query-expander LLM call |
| `src/smart-agent/llm/token-counting-llm.ts` | Remove |
| `src/smart-agent/providers.ts` | Modify — remove `TokenCountingLlm` wrapping, return `ILlm` |
| `src/smart-agent/smart-server.ts` | Modify — migrate `getUsage()` to `IRequestLogger`, update `/v1/usage` |
| `src/smart-agent/api-adapters/*.ts` | Modify — expose `model` property |
| `src/smart-agent/resilience/retry-llm.ts` | Modify — pass through `model` from inner ILlm |
| `src/smart-agent/resilience/circuit-breaker-llm.ts` | Modify — pass through `model` from inner ILlm |
| `src/index.ts` | Modify — export `IRequestLogger`, `LlmCallEntry`, `RagQueryEntry`, `ToolCallEntry`, `RequestSummary`, `LlmComponent`, `DefaultRequestLogger`, `NoopRequestLogger` |
