# Semantic History via RAG

**Issue:** #49
**Date:** 2026-04-06

## Problem

All previous messages are dumped into LLM context on every call. A 5-turn conversation costs ~15-20K tokens on history alone, growing linearly. The agent has no memory between requests unless the client preserves history.

## Solution

Store each conversation turn as a compact LLM-generated summary in a dedicated `history` RAG store. Retrieve semantically relevant past turns instead of dumping everything. Keep last N turns in a recency window for immediate context ("this class", "add a method here").

## Components

### 1. IHistorySummarizer interface

```typescript
export interface IHistorySummarizer {
  summarize(
    userIntent: string,
    assistantResult: string,
    options?: CallOptions,
  ): Promise<Result<string, LlmError>>;
}
```

Default implementation uses `helperLlm.chat()` with a configurable prompt. Override via builder or plugin.

### 2. History RAG store

New store `history` alongside facts/feedback/state/tools.

Entry format — compact LLM-generated summary:
```
User asked to create class ZCL_TEST → Created class ZCL_TEST in package ZDEV
User asked to read table T100 → Table T100 has fields SPRSL, ARBGB, MSGNR, TEXT
```

Metadata:
```typescript
{
  id: `turn:${sessionId}:${turnIndex}`,
  namespace: sessionPolicy.namespace,
  ttl: sessionPolicy.ttl,
}
```

### 3. Recency ring buffer

Array of last N compact summaries (configurable via `historyRecencyWindow`, default: 3). Stored in `SessionManager`. Always injected into system prompt regardless of RAG search.

### 4. ContextAssembler changes

Replace full `history: Message[]` injection with two sections:

- `## Recent Actions` — last N turns from recency buffer (always present)
- `## Relevant History` — semantically relevant older entries from history RAG store

Full message array no longer injected into system prompt.

### 5. Configuration

```yaml
agent:
  historyRecencyWindow: 3
  historySummaryPrompt: "Summarize in one sentence: what the user requested and what was done."
  # TTL controlled by existing sessionPolicy
```

### 6. Extension points

| Level | Mechanism | Purpose |
|-------|-----------|---------|
| Config (yaml) | `historySummaryPrompt`, `historyRecencyWindow` | Tune behavior without code |
| Plugin | `IHistorySummarizer` via plugin loader | Custom summarization logic |
| Builder | `builder.withHistorySummarizer(impl)` | Programmatic override |

Same pattern as classifier, reranker, validator.

## Data flow

```
Request N completes:
  1. tool-loop finishes → userIntent + assistantResult available
  2. IHistorySummarizer.summarize(intent, result) → compact string
  3. Upsert to history RAG store (with TTL from sessionPolicy)
  4. Push to recency ring buffer (evict oldest if > N)

Request N+1 arrives:
  1. Recency buffer → ## Recent Actions (always, last 3 turns)
  2. RAG query history store with user's new input → ## Relevant History
  3. ContextAssembler builds system prompt with both sections
  4. No full message array injection
```

## Planned forgetting

| Age | Behavior |
|-----|----------|
| Last 3 turns | Always in context via recency buffer |
| Same session, older | RAG semantic search, included if relevant |
| Past TTL (sessionPolicy) | Expired, not retrieved — agent asks for clarification |

## Token impact

| Scenario (5-turn conversation) | Before | After |
|---|----|-----|
| History in context | ~15-20K tok | ~400-600 tok |
| Summarization cost | 0 | ~500 tok/turn (one-time) |
| Net savings per subsequent request | — | ~14-19K tok |

## What changes

- `IHistorySummarizer` — new interface + default LLM-based implementation
- `SessionManager` — add recency ring buffer
- `ContextAssembler` — replace full history injection with Recent Actions + Relevant History sections
- `SmartAgentBuilder` — `withHistorySummarizer()` method
- Pipeline — post-tool-loop summarization + upsert stage
- Config — `historyRecencyWindow`, `historySummaryPrompt`

## What does NOT change

- Tool-loop internal logic
- LLM provider layer
- MCP client layer
- RAG store interface (IRag) — reuses existing upsert/query
- Classifier, reranker, validator
