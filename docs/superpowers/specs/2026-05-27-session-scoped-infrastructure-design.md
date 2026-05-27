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

- **`sessionId` — standard HTTP cookie, server-issued.** On first contact with no valid session cookie, the server mints a session id and returns `Set-Cookie` (with `Max-Age`). A cookie-aware HTTP client returns it automatically on subsequent requests — **transparent to consumer application code**. This is the maximally standard mechanism (RFC 6265) requiring zero consumer modification.
- **`userId` — only in authorization-enabled builds**, derived from the auth token. The **default server has no authorization**, so `userId` is absent and user-scope lies dormant (mechanism present, partition empty).
- **Custom headers are reserved for the non-standard only** — e.g. ABAP connection parameters (login/password or JWT), and only for implementations that need them. Custom-header handling is a **pluggable extension** the default server does not require; the core knows nothing about ABAP credentials.
- Internal abstraction: `SessionIdentity { sessionId: string; userId?: string; /* extensible */ }`.

**Caveat (documented, not a defect):** cookie transparency depends on the client keeping a cookie jar. Browsers and Python `openai`/`anthropic` SDKs (httpx.Client) persist cookies within a reused client instance; Node `openai` SDK (fetch) does not keep a jar by default. For non-cookie clients, an explicit override is allowed but is not the primary mechanism.

### A.2 Per-session graph

- Registry `Map<sessionId, SessionGraph>` on the server; **lazy build** on first request for a new/absent session cookie.
- `SessionGraph` owns: coordinator, interpreter, roles, workers, token-logger, SessionManager.
- Lives across that cookie's requests.

### A.3 RAG factory

- `scope` (`global|user|session`) is a **static store-config dimension**.
- Identity **values** are injected at view creation, when the per-session graph is built: `factory(identity: SessionIdentity, storeConfig) → identity-bound view` over the **shared** backend.
- The view knows its own partition: a session-scoped view filters by its `sessionId`, a user-scoped view by its `userId`, a global view filters nothing. The pipeline no longer threads `ctx.sessionId` into the filter per call — the view is already identity-bound.
- Multi-source (external customer RAG / consumer-MCP retrieval) is **B's** concern; A provides only the factory + identity injection.

### A.4 Lifecycle

- **Evict by idle-TTL** (default **2 hours**, configurable) **+ LRU cap on live session count** (configurable). All such limits must be configurable.
- On evict: dispose the graph → **clear session-scoped RAG records** for that `sessionId` → flush/reset the token-logger.
- **user-scoped and global RAG records survive** session eviction (user-scope is longer-lived, especially in auth builds; global is permanent).
- A request with no cookie (default `'default'` problem) resolves to an **ephemeral per-request graph** that is disposed immediately after the response — nothing accumulates, nothing "eternal". A real session exists only once a cookie is issued and returned.

### A.5 Concurrency

- **Intra-plan parallelism:** the planner decides at plan-build time which subagents may run in parallel; the interpreter dispatches them concurrently and `await`s completion. This is the existing DAG-interpreter behavior — kept.
- **Inter-request concurrency on the same session:** allowed (no forced serialization), **provided the shared session state is concurrency-safe** — token-logger appends are additive, session-RAG upserts atomic. This is a binding design constraint on every piece of shared session state.

### A.6 Provability (tests)

- Two sessions do not see each other's session-scoped records.
- Evict clears only session-scope; user/global persist.
- No-cookie request → ephemeral graph, nothing accumulates.
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

## Out of scope
- The authorization layer itself (separate downstream build supplies `userId`).
- ABAP connection-header semantics beyond the pluggable extension point.
- Persisting usage/RAG beyond process lifetime (no durable session store; in-memory registry).

## Implementation order
A (foundation) → B (scoped RAG) and C (token rollup) in parallel on top of A. One combined implementation plan with phases A → B → C.
