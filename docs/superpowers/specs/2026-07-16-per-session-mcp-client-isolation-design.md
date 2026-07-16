# Per-session MCP client isolation (#213)

**Status:** design (approved in brainstorm 2026-07-16)
**Goal:** Give each session its own MCP client(s) for tool **execution** so concurrent
tool-use requests no longer cross responses, while keeping tool **selection** on the shared
global catalog. Per-session isolation is the default; an opt-out restores today's single shared
connection.

---

## 1. Motivation (#213)

Concurrent tool-use requests to the default server cross responses: two simultaneous
`POST /v1/chat/completions` (non-stream) that each trigger an MCP tool call return **one full
answer and one silent `(no response)` / 0 tokens** — and the "winner" often balloons (~69k
tokens, as if it absorbed both histories). The consumer localized it precisely and it is
confirmed against the code:

- **Cause.** Every session shares ONE global MCP client **by reference**. `resolveSessionIdentity`
  mints a fresh `sessionId` per cookieless request, so concurrent requests get **distinct**
  `SessionGraph`s and agents (per-session isolation works for non-MCP requests — verified: two
  concurrent `17+25` return `42`/`42` with distinct token counts). But
  `session-lifecycle/index.ts` builds the graph factory with
  `mcpClientFactory: (_identity) => opts.mcpClients` — the **same** `IMcpClient[]` instances for
  every session (see `SessionGraphFactory.build` line ~91, and the standing comment "the default
  MCP factory returns the shared GLOBAL clients by reference (one upstream connection); a
  creds-aware build swaps it out").
- The consumer proved their MCP **proxy** is concurrency-safe (5 concurrent `tools/call` →
  5/5 clean, JSON-RPC `id`-correlated, served in parallel). So the crossing is **client-side**:
  the shared single-connection MCP client is not safely re-entrant across concurrent callers.
- This is the **same failure class as #219** (the shared `keepAlive` HTTP agent in
  `SapCoreAIProvider`), but for the **MCP client** rather than the LLM client. The LLM half got a
  per-call fix; the MCP half is still shared.

Per-session clients give each concurrent request its **own** client/connection with **no shared
in-flight state**, so crossing is impossible **regardless** of whether the underlying MCP SDK
client is internally concurrency-safe — sidestepping the SDK question entirely.

## 2. Design overview

**Split selection from execution.** Tool **selection** keeps using the shared global `toolsRag`
(vectorized once at startup). Tool **execution** (`callMcp`) uses **per-session** clients:

- The server's session `mcpClientFactory(identity)` — today `(_identity) => opts.mcpClients` — is
  changed so that, **by default**, it returns a **fresh set of un-connected client wrappers**
  built from the resolved `mcp:` config, one set per session identity.
- Those fresh clients are handed to `buildAgent` exactly as today (via `SmartAgentBuilder
  .withMcpClients(...)`). The builder's **provided-clients path explicitly skips both auto-connect
  AND vectorization** (`builder.ts`: `if (this._mcpClients) { /* skip auto-connect and
  vectorization */ }`), so per-session clients **reuse the shared global tool catalog** and never
  re-vectorize.
- Each session's wrappers **lazily connect on their first `callTool`** (`MCPClientWrapper.callTool`
  → `if (!this.client) await this.connect()`), so the factory stays synchronous, there is no
  upfront connect cost, and a session that never calls a tool opens no connection.
- Result: each concurrent request owns its MCP connection → no shared in-flight state → no
  crossing.

### 2.1 Opt-out

`agent.mcpSharedClient: true` → the factory returns the **shared global** clients (exact current
behavior: one upstream connection, no concurrency isolation). Absent/`false` → per-session
(the default, and the fix).

### 2.2 What is NOT changed

- **Consumer-injected clients** (`BuildAgentDeps.mcpClients`) are shared by the consumer's
  deliberate choice — the per-session default applies **only** to server-built-from-config
  clients and never overrides an injection.
- **The global startup connection stays** — it vectorizes the tool catalog at startup, backs the
  readiness/`/health` gate, and serves the embedded `buildAgent` path. Per-session connections
  are additional.
- **Non-MCP requests** and **MCP-less** deployments (no `mcp:` block) are unchanged (the factory
  returns `[]` per session → zero connections).

## 3. Components & touchpoints

- `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts` — `buildSessionLifecycle`
  gains (a) a `buildPerSessionMcpClients: () => IMcpClient[]` closure (fresh un-connected wrappers
  from the resolved `mcp:` config + the request-headers strategy) and (b) the `mcpSharedClient`
  flag. Its factory becomes
  `mcpClientFactory: (identity) => mcpSharedClient ? opts.mcpClients : buildPerSessionMcpClients()`.
- A small helper (new focused module, e.g. `mcp/build-session-mcp-clients.ts`) that builds a fresh
  `McpClientAdapter(new MCPClientWrapper(cfg))[]` from the resolved MCP configs — mirroring how the
  startup path prepares wrappers (`prepareMcpConfigs` / `connectMcpClientsFromConfig`) but WITHOUT
  connecting (lazy) and WITHOUT vectorizing.
- **Disposal stays in `server-libs`** (no `llm-agent-libs` change): the factory closure records the
  clients it builds in a `Map<sessionId, IMcpClient[]>`, and the existing
  `SessionLifecycleOptions.onDispose(sessionId)` hook — already run during `SessionGraph.dispose()`
  — disconnects and removes them. `SessionGraphFactory.build` already passes the identity to the
  factory; no change to `session-graph-factory.ts` is required.
- `packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts` — `resolveAgentSection`
  reads `agent.mcpSharedClient` (boolean, default `false`).
- `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — the `buildSessionLifecycle`
  call site passes the new closure + flag (sourced from `cfg.agent.mcpSharedClient` and `cfg.mcp`).
  No change to `buildAgent`/`buildSubAgent` (they already pass `parts.mcpClients` via
  `withMcpClients` — now those are fresh per session).

`buildMcpBridge`, `IMcpConnectionStrategy`, `SmartAgentBuilder`, and the tool-selection path are
**unchanged**.

## 4. Lifecycle / disposal

Per-session clients are owned by the session. The builder's provided-clients path deliberately has
"no per-client closeFns" (the provider owns disposal), so **we** own it in `server-libs`:

- The factory closure records each session's fresh clients in a `Map<sessionId, IMcpClient[]>`
  keyed by `identity.sessionId`. The existing `onDispose(sessionId)` hook — already invoked during
  `SessionGraph.dispose()` (idle-TTL eviction, `maxSessions` LRU drain, `disposeAll`/`invalidateAll`)
  — calls `disconnect()` on each and removes the map entry. (The server already wires `onDispose`
  to close the pipeline instance; per-session MCP disconnect is added alongside.)
- Lazy connect means a session that made no tool call has nothing to close (`disconnect()` on an
  un-connected wrapper is idempotent). No connection leak.
- The `agent.mcpSharedClient: true` path keeps today's disposal (the global clients are disposed at
  server shutdown, not per session).

## 5. Error handling / edge cases

- A per-session lazy connect failure (MCP down) surfaces through the existing fail-loud path
  (`IMcpFailureClassifier`) for **that session only** — other sessions are unaffected.
- The **global** readiness gate (`/health` → `503` when the startup MCP connection is not ready)
  is unchanged. A per-session connect failure after a healthy startup is a loud tool-call error for
  that session, not a global `503` (one session's transient MCP issue must not down the server).
- First tool-use per session pays the connect handshake once; subsequent calls reuse the session's
  connection.
- Cost: per-session connections are bounded by `maxSessions` and idle-TTL eviction (each evicted
  session disconnects its clients).

## 6. Testing (node:test, RED-first)

- **#213 regression (core):** two concurrent tool-use runs on **distinct** sessions, backed by
  fake/embedded MCP clients that record the calling identity and return session-specific results;
  assert each session's response contains only its own result — **zero crossing**, both non-empty.
  This test must FAIL on the shared-client wiring and PASS with per-session clients.
- **Factory isolation:** default → `mcpClientFactory(idA)` and `mcpClientFactory(idB)` return
  **distinct** client instances; `agent.mcpSharedClient: true` → both return the **same** shared
  instance.
- **No re-vectorization:** building a per-session agent does not call `vectorizeMcpTools` (assert
  it runs once at startup, not per session) — the catalog stays shared.
- **Disposal:** evicting/disposing a session `disconnect()`s its per-session clients (spy asserts
  disconnect called; un-connected session → no-op, no throw).
- **Backward-compat:** `agent.mcpSharedClient: true` reproduces the exact current wiring (factory
  returns `opts.mcpClients`); an injected `BuildAgentDeps.mcpClients` is still shared.
- **Live acceptance:** the consumer's exact repro — 2 concurrent tool-use `POST` on trial MCP
  :9001 — returns two real distinct answers, `0` `(no response)`, no ballooning.

## 7. Scope (YAGNI)

**IN:** per-session client factory (fresh lazy wrappers) as the default; `agent.mcpSharedClient`
opt-out; per-session disposal; the selection/execution split (reuse global catalog). **OUT:**
connection pooling / reuse across sessions of the same identity; making the shared client
re-entrant (rejected direction B); per-request (intra-session-concurrent) isolation — the reported
bug is cross-session; two concurrent requests on one cookie share the whole agent by design and are
out of scope.

## 8. Architecture-principle check

1. **Build ON components** — reuses the builder's existing provided-clients path (skip
   connect+vectorize), the wrapper's lazy connect, the existing `mcpClientFactory(identity)` seam
   (documented as the "creds-aware build" extension point), and the session teardown. No bespoke
   glue.
2. **App is the example** — the default server demonstrates correct per-session composition.
3. **Interfaces** — no interface change; `mcpClientFactory` already returns `IMcpClient[]`.
4. **Small focused modules** — the fresh-client builder is a new small `mcp/build-session-mcp-clients.ts`;
   `smart-server.ts` gains only the wiring at the `buildSessionLifecycle` call site.
5. **Variation points → config/strategy** — `agent.mcpSharedClient` is the consumer's explicit
   opt-out; injected clients remain the consumer's choice.
6. **Control file size** — no growth of the handler/composition-root logic beyond the wiring line.
7. **Don't break components** — additive/optional; `mcpSharedClient: true` is byte-behavior-identical
   to today; injected clients and MCP-less paths unchanged.
