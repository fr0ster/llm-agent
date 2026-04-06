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

## Proposed refinements

### 1. Use a dedicated memory interface instead of extending SessionManager

Avoid turning `SessionManager` into a general conversation-memory holder. Today it is a token-budget tracker only. A cleaner design is:

```typescript
export interface IHistoryMemory {
  pushRecent(sessionId: string, summary: string): void;
  getRecent(sessionId: string, limit: number): string[];
  clear(sessionId: string): void;
}
```

Default implementation can be an in-memory ring buffer. This keeps `ISessionManager` backward-compatible and avoids mixing token accounting with semantic memory.

### 2. Separate history compression from semantic turn memory

The current system already uses `historySummaryPrompt` for message-array compression when history gets too long. Semantic turn memory is a different mechanism and should use separate config keys:

```yaml
agent:
  historyAutoSummarizeLimit: 10
  historyCompressionPrompt: "Summarize the conversation so far in 2-3 sentences."
  historyTurnSummaryPrompt: "Summarize in one sentence: what the user requested and what was done."
  historyRecencyWindow: 3
```

This avoids prompt ambiguity and lets both mechanisms coexist during migration.

### 3. Strengthen the summarizer contract

Instead of passing only `userIntent` and `assistantResult`, pass a richer turn payload:

```typescript
export interface HistoryTurn {
  sessionId: string;
  turnIndex: number;
  userText: string;
  assistantText: string;
  toolCalls: Array<{ name: string; arguments: unknown }>;
  toolResults: Array<{ tool: string; content: string }>;
  timestamp: number;
}

export interface IHistorySummarizer {
  summarize(
    turn: HistoryTurn,
    options?: CallOptions,
  ): Promise<Result<string, LlmError>>;
}
```

This gives the summarizer access to actual side effects, not just the final answer text.

### 4. Require namespace-safe retrieval

History retrieval must be session-safe by design, not by convention. Every history query should include the session namespace filter derived from `sessionPolicy` or request context:

```typescript
const historyOptions: CallOptions = {
  ...options,
  ragFilter: {
    ...options?.ragFilter,
    namespace: sessionPolicy.namespace,
  },
};
```

If no namespace is configured, either:

- treat history memory as session-local only, or
- derive an internal namespace from `sessionId`.

Do not allow shared `history` retrieval across sessions by default.

### 5. Keep recent raw dialogue, not only summaries

For the recency window, storing only compact summaries may lose essential deixis such as "here", "this field", "rename the previous method". Prefer one of these approaches:

- Keep the last N raw user/assistant turns in normal history.
- Keep the last N raw user messages plus compact assistant outcome summaries.
- Keep both raw turn text and summary in the memory object, using summary for RAG and raw text for recency injection.

Recommended default: raw last 2 turns + summarized older memory.

### 6. Limit what gets injected into ContextAssembler

Do not remove all regular history at once. The safer migration path is:

1. Keep the last 1-2 raw turns in `history`.
2. Add `## Recent Actions` from memory.
3. Add `## Relevant History` from the history RAG store.
4. Measure quality before fully removing longer raw history injection.

This reduces regression risk for follow-up instructions that rely on exact phrasing.

### 7. Define write timing and failure policy explicitly

The spec should state what happens if summarization or upsert fails after a successful response:

- User response must still succeed.
- Failure to summarize or upsert is non-fatal.
- Recency buffer write may fall back to raw assistant summary text.
- Errors should be logged with request/session correlation.

Suggested flow:

```text
final response produced
  -> best-effort summarize turn
  -> best-effort upsert to history store
  -> best-effort update recency memory
```

### 8. Add rollout and compatibility mode

Introduce a feature flag so the design can be enabled gradually:

```yaml
agent:
  semanticHistoryEnabled: false
```

Recommended rollout stages:

1. Write-only: summarize and upsert turns, but do not read them yet.
2. Read-shadow: retrieve history and log it, but do not inject it.
3. Partial injection: inject history while still keeping short raw dialogue.
4. Full mode: reduce raw history to the minimal recency window.

### 9. Document token economics conservatively

The current token estimates are directionally useful, but they should be framed as approximate and workload-dependent. Add caveats:

- semantic retrieval may return irrelevant items without reranking thresholds;
- turn summarization adds fixed cost every request;
- recency still consumes tokens;
- low-quality summaries can create hidden error accumulation.

### 10. Add acceptance criteria

The spec would be more actionable with explicit acceptance criteria:

- A 10-turn session does not inject all prior raw messages into the final LLM call.
- Retrieved history never crosses namespace/session boundaries.
- If history summarization fails, the request still completes successfully.
- If history store is unavailable, the agent falls back to recency-only behavior.
- Follow-up prompts like "rename that method" still work across at least the last 2 turns.
