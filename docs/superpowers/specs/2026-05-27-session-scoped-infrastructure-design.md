# Session-Scoped Infrastructure — Design

**Status:** active (design approved 2026-05-27)
**Release:** BLOCKS 17.0.0 — without correct scoping, most consumer functionality either does not work or its correctness cannot be proven, because all consumers run with different sessions (and, in auth builds, different users).

## Goal

Give consumers running with different sessions/users **correct, provable scoping**. Today the server is effectively per-request stateless and every subagent (worker) is built as an isolated `SmartAgent` with its **own** RAG store and its **own** `requestLogger`. Consequently:

- Session/user context written in one place is invisible to the workers that should consume it.
- Worker token usage never reaches the server's `/v1/usage` (only the coordinator's own auxiliary `translate` call shows; verified live: DAG `/v1/usage` = 85 tok while the worker did 7 tool calls).
- The per-response `usage` is always `{0,0,0}`.

This epic introduces **session-scoped infrastructure**: a per-session object graph keyed by a server-issued identity, identity-bound RAG views over shared storage, and a session-scoped token-usage rollup.

## Two orthogonal planes

The design separates two axes that were previously conflated:

1. **Object lifecycle / ownership (per-session instances).** A session owns a live runtime graph — coordinator, interpreter, roles (planner/reviewer/state-oracle), workers, token-logger, SessionManager. These are instantiated per session and live across that session's requests.
2. **RAG scope (access parameter over shared storage).** RAG objects are not per-session data copies; they are identity-bound *views* over a shared backend (Qdrant / Vectorized Custom Store / …). `scope` (`global|user|session`) is a static store-config dimension; the identity **values** (sessionId, userId, …) are injected when the view is created for a session.

| Object | Plane | Nature |
|---|---|---|
| Coordinator / Interpreter | 1 | per-session instance (dialog state) |
| Roles: planner / reviewer / state-oracle | 1 | per-session instance |
| Workers (subagents + their pipeline) | 1 | per-session instance |
| Token-logger | 1 | per-session (session's spend) |
| SessionManager | 1 | per-session |
| RAG stores (Qdrant / custom) | 2 | shared handle; scope = call/identity parameter |

---

## A. Session Foundation

The substrate B and C build on.

### A.1 Identity

- **`sessionId` — standard HTTP cookie, server-issued.** On any request with no valid session cookie, the server mints a **unique** session id and returns `Set-Cookie` (with `Max-Age`), and **that request already runs in the minted session's graph — its state persists** (there is no separate one-shot/ephemeral path). A cookie-aware HTTP client returns the cookie automatically on subsequent requests and **continues the same session**; a client that never returns it (no jar) mints a fresh, never-continued session each time. This is the maximally standard mechanism (RFC 6265) requiring zero consumer modification. Because every no-cookie request gets a **unique** id, there is no shared `'default'`/"eternal" bucket — never-continued sessions are reaped by TTL/LRU (A.4).
- **`userId` — only in authorization-enabled builds**, derived from the auth token. The **default server has no authorization**, so `userId` is absent and user-scope lies dormant (mechanism present, partition empty).
- **Custom headers are reserved for the non-standard only** — e.g. ABAP connection parameters (login/password or JWT), and only for implementations that need them. Custom-header handling is a **pluggable extension** the default server does not require; the core knows nothing about ABAP credentials.
- Internal abstraction: `SessionIdentity { sessionId: string; userId?: string; /* extensible */ }`.

**Caveat (documented, not a defect):** cookie transparency depends on the client keeping a cookie jar. Browsers and Python `openai`/`anthropic` SDKs (httpx.Client) persist cookies within a reused client instance; Node `openai` SDK (fetch) does not keep a jar by default. For non-cookie clients, an explicit override is allowed but is not the primary mechanism.

### A.2 Per-session graph

- Registry `Map<sessionId, SessionGraph>` on the server; **lazy build** on first request for a new/absent session cookie (the minting request, A.1, runs in this newly built graph).
- `SessionGraph` owns the per-session runtime: coordinator, interpreter, roles, workers, token-logger, SessionManager, **and the already-session-keyed runtime stores** — `ToolAvailabilityRegistry` (`packages/llm-agent-libs/src/policy/tool-availability-registry.ts`) and `PendingToolResultsRegistry` (`packages/llm-agent-libs/src/policy/pending-tool-results-registry.ts`). These are currently built **per-request** in `default-pipeline.ts` (~line 411) even though both are keyed by `sessionId`; moving them into the SessionGraph is required so **pending async tool results and temporary tool blocklists survive subsequent requests in the same session**. Audit for any other sessionId-keyed runtime state and hoist it here too.
- Lives across that cookie's requests.

### A.3 RAG factory

- `scope` (`global|user|session`) is a **static store-config dimension**.
- Identity **values** are injected at view creation, when the per-session graph is built: `factory(identity: SessionIdentity, storeConfig) → identity-bound view` over the **shared** backend.
- The view knows its own partition: a session-scoped view filters by its `sessionId`, a user-scoped view by its `userId`, a global view filters nothing. The pipeline no longer threads `ctx.sessionId` into the filter per call — the view is already identity-bound.
- Multi-source (external customer RAG / consumer-MCP retrieval) is **B's** concern; A provides only the factory + identity injection.

### A.4 Lifecycle

- **Evict by idle-TTL** (default **2 hours**, configurable) **+ LRU cap on live session count** (configurable). All such limits must be configurable.
- **Active-request pin (refcount).** Each in-flight request increments the SessionGraph's refcount; it is decremented when the request completes. **Neither idle-TTL nor LRU eviction may dispose a graph with refcount > 0** — eviction selects only idle (refcount 0) sessions, or marks a session for disposal and drains: the graph is disposed (and its session RAG cleared, token-logger flushed) only after the last in-flight request finishes. This prevents tearing down RAG/logger/interpreter under a live run, which A.5's inter-request concurrency makes possible.
- On evict (of an unpinned graph): dispose the graph → **clear session-scoped RAG records** for that `sessionId` → flush/reset the token-logger.
- **user-scoped and global RAG records survive** session eviction (user-scope is longer-lived, especially in auth builds; global is permanent).
- There is **no separate ephemeral/one-shot path** (see A.1): every request runs in a real session graph; never-continued sessions (no-jar clients) simply become idle and are reaped by TTL/LRU. Nothing is "eternal" because each no-cookie request gets a unique id rather than sharing a `'default'` bucket.

### A.5 Concurrency

- **Intra-plan parallelism:** the planner decides at plan-build time which subagents may run in parallel; the interpreter dispatches them concurrently and `await`s completion. This is the existing DAG-interpreter behavior — kept.
- **Inter-request concurrency on the same session:** allowed (no forced serialization), **provided the shared session state is concurrency-safe** — token-logger appends are additive, session-RAG upserts atomic. This is a binding design constraint on every piece of shared session state. Concurrent requests each pin the graph via the A.4 refcount, so eviction cannot dispose it mid-run.

### A.6 Provability (tests)

- Two sessions do not see each other's session-scoped records.
- Evict clears only session-scope; user/global persist.
- A no-cookie request gets a **unique** minted session id, runs in that minted graph, and its state persists within it (no shared `'default'` bucket); a no-jar client that never returns the cookie creates separate, never-continued sessions that are reaped by TTL/LRU.
- Token-logger sums per session and resets on evict.

---

## B. Scoped RAG (multi-source) — builds on A

### B.1 Store contents
Session artifacts (**skills count as a session-scoped artifact**) + the MCP-tools catalog (the store a subagent queries to pick the right tool).

### B.2 Scopes
`global|user|session` — static store-config dimension; identity values supplied by A's factory.

### B.3 Sources (per-subagent config, any combination)
1. **Internal scoped stores** (Qdrant/custom) via A's identity-bound factory.
2. **External customer RAG** — a subagent points at the consumer's RAG backend (an `IRag` adapter; connection from config/headers).
3. **Consumer-provided MCP retrieval** — retrieval performed by a consumer-injected MCP tool; the agent owns no store, the "RAG" is a tool call.

### B.4 Per-subagent store map
Each subagent declares which named stores it consumes and at what scope. **Workers no longer build an isolated `makeRag`**; session/user stores are taken as identity-bound views from the session graph's RAG factory, the global tools-catalog is shared.

### B.5 buildSubAgent fix
Replace each worker's isolated `makeRag(subCfg.rag)` with views obtained from the session graph's RAG factory (plus shared global stores).

### B.6 Provability (tests)
- A session artifact written by the coordinator/one worker is visible to another worker that opts into that session store.
- A subagent configured for external customer RAG / consumer MCP retrieval routes there and owns no internal store.
- Tool-selection still works against the (global) MCP-tools catalog store.

---

## C. Session token-rollup + non-zero per-response usage — builds on A

### C.1 One token-logger per SessionGraph
Shared by the coordinator **and all workers** (replacing each worker's own `DefaultRequestLogger`), so worker tool-loop/embedding tokens land in the session's accounting. Note: `ISubAgentResult.usage` already exists and `SmartAgentSubAgent` already populates it, but neither the DAG interpreter nor the coordinator reads it today — a shared logger removes the need to marshal usage up the call chain.

### C.2 Two accounting axes in the logger
- **Request-scoped delta** (for response `usage`) — **keyed by request id**, because inter-request concurrency (A.5) makes a single mutable `requestLlmCalls` + `startRequest()`-reset unsafe (the current `DefaultRequestLogger.startRequest()` clears `requestLlmCalls`, which a concurrent or nested call would stomp).
  - **Request id = the existing `traceId`.** The server already mints `traceId` per request and threads it through `options.trace.traceId` (`smart-server.ts` ~1342/1390). The design adopts this as the request id; no new id is introduced. **Contract:** every `logLlmCall` (coordinator, classifier, translate, embedding, and every worker tool-loop) must record under the active `traceId`, and the SessionGraph must thread `traceId` into worker dispatch so worker-side log calls attribute to the same request. `getSummary` gains a per-`traceId` view (request delta) alongside the session-cumulative view. Worker pipelines therefore receive `traceId` in `ISubAgentInput`/call options.
- **Session-cumulative** — the per-session sum, for `/v1/usage` (selectable by `sessionId`).

### C.3 Non-zero per-response usage
The coordinator path populates `response.usage` from the request-scoped delta (sum of all components incl. workers) so the OpenAI/Anthropic adapter emits it (today it reads `response.usage`, which the coordinator path never sets → always 0).

### C.4 Honesty about external retrieval
When retrieval is via a consumer MCP tool, that cost is a **tool call, not our tokens**; our embedding cost (when we embed) is a separate line. Never attribute the consumer's cost to us.

### C.5 Reset
Session-cumulative resets on session evict (A.4 lifecycle).

### C.6 Provability (tests)
- Worker tokens appear in `/v1/usage`.
- Per-response `usage` is non-zero and equals the component sum.
- Session total accumulates across the session's requests and resets on evict.
- Concurrent requests on one session do not mix request-deltas.
- External MCP retrieval is not counted as our tokens.

---

## Existing infrastructure to REUSE (do not reinvent)

A code inventory (2026-05-27) found much of the RAG scoping already implemented; the plan must build on it:

- **`SimpleRagRegistry`** (`packages/llm-agent/src/rag/registry/simple-rag-registry.ts`) — `createCollection({providerName, collectionName, scope, sessionId, userId})` creates an identity-bound collection; **`closeSession(sessionId)`** already deletes all `scope==='session'` collections for a sessionId.
- **`IRagProvider` / `AbstractRagProvider`** (`packages/llm-agent/src/rag/providers/`) — `supportedScopes`, `SessionScopedIdStrategy(sessionId)`; in-memory/vector/qdrant/hana/pg providers create identity-bound collections.
- **Live projection** registry → `ctx.ragStores` (builder.ts ~807-825) via a mutation listener — once at build, kept in sync.
- **`rag-query` scope filter** (rag-query.ts:74-86) already maps `scope: global|user|session` → `ragFilter` from `ctx.sessionId` / `ctx.options.userId`.
- **`SmartAgent.closeSession(sessionId)`** (agent.ts:408-420) already calls `ragRegistry.closeSession` + `historyMemory.clear`. **Gap: nothing triggers it** — the server never calls it.
- **`ToolAvailabilityRegistry` / `PendingToolResultsRegistry`** are sessionId-keyed but built per-request (default-pipeline.ts:411-412) — A must hoist them to the SessionGraph.

What is genuinely MISSING (the plan's real work): cookie identity + `Set-Cookie` (A.1); the per-session graph registry + eviction manager with TTL/LRU/refcount that triggers `closeSession` (A.2/A.4); worker sharing of the parent `ragRegistry` instead of isolated `makeRag` (B.5); the per-session shared token-logger + subagent-usage aggregation + non-zero per-response usage (C). `userId`/auth stays out of scope (downstream build).

## Out of scope
- The authorization layer itself (separate downstream build supplies `userId`).
- ABAP connection-header semantics beyond the pluggable extension point.
- Persisting usage/RAG beyond process lifetime (no durable session store; in-memory registry).

## Implementation order
A (foundation) → B (scoped RAG) and C (token rollup) in parallel on top of A. One combined implementation plan with phases A → B → C.
