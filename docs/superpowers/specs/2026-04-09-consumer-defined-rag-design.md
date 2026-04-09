# Consumer-Defined RAG Only — Design Spec

**Issue:** #84  
**Date:** 2026-04-09  
**Status:** Draft  
**Breaking:** Yes

## Problem

SmartAgent has 3 hardcoded RAG stores (`facts`, `feedback`, `state`) that are automatically created and populated. This violates llm-agent's core principle of being an agnostic, provider-independent orchestration layer:

1. **Uncontrolled data persistence** — conversation content leaks into long-term stores without consumer intent
2. **Wrong store semantics** — `state` was designed for SAP support cases (global), but rag-upsert writes per-user Q&A
3. **No consumer control** — consumer cannot define their own RAG stores with custom semantics
4. **CLR doesn't clear** — user expects "clear" to forget everything, but facts/state persist

## Goal

Make llm-agent maximally agnostic. The minimal default agent provides only MCP tool selection and conversation history — everything else is consumer-defined.

## Design

### Two-Level Architecture

| Level | Responsibility | Configures |
|-------|---------------|------------|
| **Builder (global)** | DI of dependencies | LLM, embedder, MCP clients, tools RAG, history RAG, pipeline |
| **Pipeline (request)** | Request processing orchestration | When/how to query/upsert stores, parallelism, classifier, plugins |

Builder defines **what** the agent works with. Pipeline defines **how** requests are processed.

### Builder — Global Dependencies via DI

Builder accepts ready-made interface implementations. No domain logic, no store creation from config.

```typescript
builder
  .setLlm(myLlm)                          // ILlm
  .setEmbedder(myEmbedder)                 // IEmbedder
  .setMcpClients([mcp1, mcp2])             // IMcpClient[]
  .setToolsRag(myToolsRag)                 // IRag — override auto-created
  .setHistoryRag(myHistoryRag)             // IRag — override auto-created
  .setPipeline(new DefaultPipeline())      // IPipeline
  .build();
```

**tools RAG:**
- Auto-created (in-memory) when MCP clients are configured and embedder is available
- Consumer overrides via `setToolsRag(IRag)` — e.g. Qdrant for large tool catalogs
- Pipeline writes tools after MCP connection, queries during request processing

**history RAG:**
- Auto-created (in-memory) when history summarization is enabled
- Consumer overrides via `setHistoryRag(IRag)` — e.g. persistent store for cross-session history
- Pipeline writes after agent response, queries during request processing

### Pipeline — Request Processing

`IPipeline` interface — defines how the agent processes each request.

This is a **full replacement** for the current structured pipeline runtime and YAML
stage DSL. After this change, there is only one orchestration model:

- Builder wires dependencies
- `IPipeline` orchestrates request processing
- No parallel legacy path in core
- No stage-tree YAML executor in core

**Implementations:**

1. **`DefaultPipeline`** — hardcoded, minimal:
   - Classify → parallel query all stores → tool-select → assemble → tool-loop → history upsert
   - Knows only about `tools` and `history` stores
   - No plugins, no consumer-defined stores

2. **Custom consumer pipeline** — configurable:
   - Consumer provides their own `IPipeline` implementation
   - May use YAML, DB config, code, or any other source internally
   - Supports plugins that register additional stores + classifier extensions
   - Consumer controls full pipeline topology

```typescript
// Default — minimal agent
builder.setPipeline(new DefaultPipeline());

// Consumer-defined pipeline
builder.setPipeline(
  new CompanyPipeline({ plugins: [companyDocsPlugin, sapNotesPlugin] })
);
```

### Default Pipeline Flow

```
classify
  ↓
summarize (conditional: historyAutoSummarize enabled)
  ↓
[PARALLEL rag-query]
  ├─ query → tools store
  └─ query → history store
  ↓
rerank (conditional)
  ↓
skill-select (conditional)
  ↓
tool-select
  ↓
assemble
  ↓
tool-loop
  ↓
[PARALLEL post-processing]
  ├─ history-upsert → history store (after response)
  └─ tools-upsert → tools store (after MCP reconnect, if tools changed)
```

`DefaultPipeline` is intentionally **minimal and non-extensible**:

- Queries only `tools` and `history`
- Writes only `tools` and `history`
- Knows nothing about consumer-defined domain stores
- Does not load plugins
- Does not provide `facts` / `feedback` / `state` compatibility

Any additional stores or request logic require a consumer-provided `IPipeline`.

### Plugin Interface

Plugins live inside consumer pipeline implementations, not in builder. A plugin
extends the consumer pipeline with additional RAG stores and classifier knowledge.

```typescript
interface ISmartAgentPlugin {
  name: string;
  ragStores: Record<string, IRagStoreConfig>;
  classifierPromptExtension?: string;
}

interface IRagStoreConfig {
  rag: IRag;
  scope: 'global' | 'user' | 'session';
  ttl?: number; // default TTL in seconds for records in this store
}
```

Example:

```typescript
const companyDocsPlugin: ISmartAgentPlugin = {
  name: 'company-docs',
  ragStores: {
    'company-docs': { rag: qdrantRag, scope: 'global' },
  },
  classifierPromptExtension:
    'If the user asks about company policies, classify as type "company-docs".',
};

builder.setPipeline(
  new CompanyPipeline({ plugins: [companyDocsPlugin] })
);
```

Plugin registers stores and classifier extension. The consumer pipeline decides
when and how to query/upsert them. The default pipeline ignores plugins.

### Scope Model

Scope defines **who sees** and **how long** data lives:

| Scope | Visibility | Lifecycle | Filter at query |
|-------|-----------|-----------|-----------------|
| `global` | All users | Persistent (backend-dependent) | None |
| `user` | Single user | Persistent, filtered by user ID | `metadata.userId === currentUserId` |
| `session` | Single user, single session | Ephemeral, deleted on session close | `metadata.sessionId === currentSessionId` |

**Metadata injection at upsert:**
- Pipeline automatically adds `userId` / `sessionId` to metadata based on store scope
- Consumer does not manage this — scope declaration drives behavior

**Contract note:**
- Scope metadata injection is performed by the pipeline
- Scope isolation is guaranteed only if the selected RAG backend correctly honors metadata filters
- Builder does not enforce isolation by itself
- Custom backends that ignore scope filters break the isolation contract

**TTL:**
- Orthogonal to scope — records expire independently of scope lifecycle
- Defined per-store at registration (default for all records)
- Can be overridden per-record at upsert (e.g. cache results with short TTL)
- User conversation data: no TTL (lives as long as scope allows)
- Cached/computed data: with TTL

**Session cleanup:**
- On session close, session-scoped stores are cleared
- Default in-memory implementations: cleanup built-in
- Custom backends: consumer responsibility

### Classifier Changes

**Default classifier** knows only about:
- `action` — tool call needed
- `chat` — conversational response
- `tools` — tool-related query (if tools store exists)
- `history` — history-related query (if history store exists)

**No `fact`, `feedback`, `state` types** in default classifier.

**Intent model becomes extensible:**
- The default pipeline may use a minimal built-in intent union such as `action | chat | tools | history`
- Consumer-defined pipelines must be allowed to classify into arbitrary string types
- Core must not hardcode `fact` / `feedback` / `state` as privileged intent categories
- Routing of custom intent types to custom stores is defined by the consumer pipeline, not by core name conventions

Consumer extends classifier knowledge via plugin's `classifierPromptExtension` — when a plugin registers a store like `company-docs`, it also tells the classifier when to produce that type.

## What Changes

### Removed

| Component | Action |
|-----------|--------|
| `facts`/`feedback`/`state` default store creation in SmartServer | Delete |
| Structured pipeline runtime / stage-tree YAML DSL in core | Delete |
| `withRag(Record<string, IRag>)` builder method | Delete |
| `withRagUpsert(boolean)` builder method | Delete |
| `withRagRetrieval(mode)` builder method | Delete |
| `withRagTranslation(boolean)` builder method | Delete |
| Hardcoded 3× `rag-query` in default pipeline | Replace with dynamic |
| Namespace/TTL policy system | Replace with scope model |
| `RagUpsertHandler` (current form) | Refactor — generic, scope-aware |

### Added

| Component | Description |
|-----------|-------------|
| `setToolsRag(IRag)` builder method | DI for tools store override |
| `setHistoryRag(IRag)` builder method | DI for history store override |
| `setPipeline(IPipeline)` builder method | DI for pipeline implementation |
| `IPipeline` interface | Pipeline abstraction |
| `DefaultPipeline` | Minimal pipeline: tools + history only |
| `ISmartAgentPlugin` interface | Plugin contract for custom stores |
| `IRagStoreConfig` type | Store config with scope + TTL |
| Scope-based filtering in rag-query | Auto-filter by userId/sessionId |
| Session cleanup for in-memory stores | Auto-clear on session close |
| Extensible intent types | Consumer-defined pipelines can use arbitrary store/intention names |

### Unchanged

| Component | Notes |
|-----------|-------|
| `IRag` interface | query/upsert/healthCheck stay minimal, but implementations must honor scope filters if they claim scoped isolation |
| RAG implementations | InMemoryRag, VectorRag, QdrantRag, OllamaRag |
| `IEmbedder` / `IEmbedderBatch` | Embedding interfaces |
| Tool vectorization logic | Moves under pipeline control but same algorithm |
| `IReranker`, `IQueryExpander` | Stay as pipeline-level concerns |

## Migration

This is a **breaking change**. Consumers must:

1. Remove reliance on default `facts`/`feedback`/`state` stores
2. Replace `withRag()` calls with `setToolsRag()` / `setHistoryRag()` or a custom pipeline-owned store registry
3. Replace `withRagUpsert(false)` with pipeline behavior
4. Replace structured YAML stage definitions with an `IPipeline` implementation
5. Add `setPipeline()` call (or rely on `DefaultPipeline` auto-selection)
6. If using custom stores — implement them in a custom pipeline (plugins optional)

### Before

```typescript
builder
  .withLlm(llm)
  .withMcpClients([mcp])
  .withRag({ facts: rag, feedback: rag, state: rag })
  .withRagUpsert(false)
  .build();
```

### After

```typescript
builder
  .setLlm(llm)
  .setMcpClients([mcp])
  .setPipeline(new DefaultPipeline())
  .build();
// No facts/feedback/state — tools + history auto-created
```

### With custom stores

```typescript
const plugin: ISmartAgentPlugin = {
  name: 'domain-knowledge',
  ragStores: {
    facts: { rag: factsRag, scope: 'user' },
    feedback: { rag: feedbackRag, scope: 'session' },
  },
  classifierPromptExtension: 'Classify factual statements as "facts", user feedback as "feedback".',
};

builder
  .setLlm(llm)
  .setMcpClients([mcp])
  .setToolsRag(qdrantToolsRag)
  .setPipeline(new CompanyPipeline({ plugins: [plugin] }))
  .build();
```
