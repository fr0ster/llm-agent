# MCP Readiness & Fail-Loud — Design

**Status:** draft (awaiting review)
**Date:** 2026-06-25
**Goal:** When a configured MCP server is unavailable — at startup or after going
down mid-life — the SmartServer must (a) NOT silently serve tool-blind
`(no response)` answers, (b) surface a loud error to the consumer from the pipeline
component, and (c) move to a NOT-READY state that automatically recovers to READY
when MCP returns, resuming request intake.

---

## 1. Problem

Surfaced by the grounded pipeline-comparison eval (memory: `project_mcp_health_failloud`).
When MCP returns 403 / 502 / `-32001 timeout` / drops the connection:

- The pipeline proceeds **tool-blind** and the server returns a silent
  `(no response)` with **HTTP 200** — the failure is invisible to the consumer.
- MCP health is *already detected* (`HealthChecker.check()` → `agent.healthCheck()`
  → `{ llm, rag, mcp: [...] }`) but MCP-down only yields **`degraded` + HTTP 200**
  on `/health` (health-checker.ts:58–59); the server keeps accepting requests.

### Concrete swallow points (verified in code)

1. `health-checker.ts:55–62` — MCP-down → `degraded`, never `unhealthy`; `/health`
   returns 503 only when **LLM** is down (smart-server.ts:3108). MCP-down ⇒ 200.
2. `smart-server.ts:3632` — `result.value.content || (toolCalls ? null : '(no response)')`
   — an empty assistant turn (the tool-blind degraded case) becomes a silent
   `(no response)` 200.
3. `smart-server.ts:955` (`buildMcpBridge`) — `if (!listed.ok) continue;` — a
   transient `listTools` failure makes the tool **vanish**; the LLM gets
   `Tool not found: <name>` instead of a real transport error.
4. `client.ts:253–282` (`connect()`) — on reconnect the new HTTP transport is built
   with `this.config.sessionId`, ignoring the **live** server-assigned
   `this.sessionId` (captured :281, survives `disconnect()`). Every reconnect starts
   a FRESH session → server-side session state / in-flight tool result is lost.

---

## 2. Decisions (locked)

- **Startup with MCP down → start NOT-READY** (not fail-loud-at-start). The process
  comes up, reports not-ready, and a background probe flips it READY when MCP
  appears. Survives a cold MCP. **Implication:** startup MCP connect must NOT throw on
  failure — it records the target as a DOWN slot (§3.1) and the monitor retries it.
  (Changes `connectMcpClientsFromConfig`'s throw-on-connect into a recorded-unhealthy
  target.)
- **Readiness covers worker/subagent MCP** (`subCfg.mcp` / `subCfg.mcpClients`), not
  just global — the registry is keyed on configured targets (§3.1).
- **Spec-first**, then implement in reviewed PRs.

---

## 3. Design

### 3.1 Readiness state machine (SmartServer)

A single server-level readiness signal, derived from MCP (and LLM) health:

```
READY      ⟺  llm ok  AND  every configured MCP target healthy
NOT_READY  ⟺  otherwise   (incl. a target whose connect has not yet succeeded)
```

- Held as an explicit field on SmartServer (e.g. `_ready: boolean`, default `false`
  until the first successful probe). MCP-with-zero-clients (MCP-less deployments)
  is always "mcp ok" → readiness reduces to `llm ok` (no behaviour change for the
  no-MCP case).
- Transitions are driven by **two** sources:
  - the **background probe** (§3.4), and
  - **in-flight request failures** (§3.3) — a request that hits an unrecoverable MCP
    error flips the server NOT_READY immediately (don't wait for the next probe
    tick).

#### Readiness source — a SmartServer-owned MCP **target registry** (slots, not bare clients)

> **Review P1b + cold-start (P1).** `agent.healthCheck()` only probes the top-level
> agent's `_activeClients` (agent.ts:269/471) — worker/subagent MCP (smart-server.ts
> 2052/2446) is invisible. AND a registry of *live clients* cannot represent a
> cold-MCP startup: `connectMcpClientsFromConfig()` awaits `wrapper.connect()` and
> **throws** on failure (smart-server.ts:939), so a down-at-boot MCP produces no
> client to register → either startup still throws (violates "start NOT_READY") or
> "zero clients = ok" (false READY).

The readiness source is therefore a registry of **configured MCP targets**, modelled
on the existing `LazyConnectionStrategy.Slot` (lazy-connection-strategy.ts:11):

```
Slot { config: McpConnectionConfig; client?: IMcpClient;  // live handle, may be absent
       healthy: boolean; lastAttempt: number }
```

- The registry is built from **config**, not from successful connections: every
  configured MCP target gets a slot at `start()` even if its connect fails. A slot
  with no healthy client ⇒ that target is DOWN ⇒ server NOT_READY. This is what makes
  "cold-MCP startup → NOT_READY (not a thrown start)" implementable. **Startup connect
  no longer throws on MCP-down** — a failed connect records the slot unhealthy and the
  monitor (§3.4) retries it on cooldown.
- **Targets covered (contract DECISION, review P1b — no longer punted):** readiness
  includes **both**
  - shared/global targets (`cfg.mcp` → `connectMcpClientsFromConfig` / `connectMcp`
    seam), and
  - **worker/subagent targets** (`subCfg.mcp` and DI `subCfg.mcpClients` from every
    subagent config). DAG/stepper examples put MCP in worker configs, so excluding
    them would make `/health` lie for those pipelines.
- **Where a live handle already exists** (global clients, DI `subCfg.mcpClients`) the
  slot reuses it for probing. **Where SmartServer has only the config** (builder-
  connected `subCfg.mcp`, whose handle the builder owns and does not surface), the
  readiness monitor owns its OWN lazy probe-connection to that target — independent of
  the builder's per-worker connection — so the target is still probed/recovered. (This
  is the explicit resolution of the former §6 punt: register the TARGET, not the
  unreachable handle.)
- Slots are registered as SmartServer builds targets (global at `start()`, workers as
  their configs are read) and deregistered on close. The readiness monitor (§3.4)
  probes this registry; LLM health stays via the existing path.

### 3.2 Request gate (fail-loud, replaces silent `(no response)`)

On the pipeline request paths (`/v1/chat/completions`, `/v1/messages`, streaming and
non-streaming):

- **Before dispatch (NOT_READY):** respond **HTTP 503** with an explicit OpenAI-shaped
  error body, e.g.
  `{"error":{"type":"service_unavailable","message":"MCP unavailable — server not ready"}}`.
  Do NOT run the pipeline.
  - **Streaming requests are split (review P2b):**
    - *Pre-dispatch* (readiness checked BEFORE any byte is written): return a normal
      **HTTP 503 JSON error** — do NOT open a `200` SSE stream first. The gate runs
      before `res.writeHead(200, …text/event-stream…)`.
    - *In-flight* (MCP fails AFTER the 200 SSE headers are already sent): the status
      line is committed, so emit a single SSE error event (`data: {"error":…}`) then
      `res.end()` — NO `[DONE]` (which would mask the failure as a clean finish).
- **`(no response)` fallback (smart-server.ts:3632):** keep `(no response)` ONLY for
  a genuinely empty-but-successful turn. When the run degraded due to MCP
  unavailability, the component throws (next section) → `result.ok === false` →
  the existing `Error: ${result.error.message}` path (3633) carries it. We also map
  that to a non-200 status where the response shape allows.

### 3.3 In-flight fail-loud — ALL MCP execution surfaces

> **Review P1a.** `buildMcpBridge` is only the controller/stepper surface. The core
> SmartAgent tool loop converts any `!res.ok` into tool-result **text** fed back to
> the LLM (agent.ts:1882–1886), and the pipeline-handler tool-loop (tool-loop.ts)
> does the same. So flat / default / linear loops keep feeding "MCP error" to the
> model instead of failing loud. The policy below applies at EVERY surface.

#### Error classification (the enabling primitive)

Not every tool failure is an availability failure. A tool that *ran* and returned an
error payload is legitimate LLM feedback; a *transport/availability* failure is not.
Distinguish them by a stable `McpError` **code**:

- **AVAILABILITY** — `NOT_CONNECTED`, transport/connect failure, `-32001` timeout,
  HTTP 403/502/503 from the MCP endpoint, "no response after reconnect" (§3.5). The
  `McpClientAdapter`/`MCPClientWrapper` tag these with an availability code.
- **TOOL_ERROR** — the tool executed and returned an error result (or a 4xx that is
  about the *arguments*, not the endpoint). Stays as text to the LLM (today's
  behaviour, unchanged).

A shared helper `isMcpUnavailable(err): boolean` (keyed on the code) is the single
source of truth used at every surface.

#### Per-surface policy

- **Core SmartAgent tool loop (agent.ts:1882):** when `!res.ok && isMcpUnavailable`,
  do NOT stringify the error into the tool message — abort the loop and surface a
  typed `McpUnavailableError` up the `process()` Result (`result.ok === false`).
  TOOL_ERROR stays text.
- **Pipeline-handler tool-loop (tool-loop.ts):** same classification + abort/surface.
- **`buildMcpBridge` (smart-server.ts:945–966):** distinguish *"no client owns this
  tool"* (→ keep `Tool not found`) from *"a client's `listTools()`/`callTool` failed
  with an availability error"* (→ throw `McpUnavailableError`, do NOT `continue` past
  it as if the tool were absent).

#### Propagation & side effect

- The typed error propagates out of the coordinator/pipeline component as an
  orchestrator error → the consumer sees a real failure (embedding consumers catch
  it; the HTTP surface returns non-200 / `Error: …`, never a silent `(no response)`).
- Any AVAILABILITY error observed in-flight ALSO flips the server NOT_READY (§3.1) —
  immediately, without waiting for the next probe tick.

### 3.4 Background health probe (recovery + proactive detection)

- A periodic monitor (interval configurable, default e.g. 10s) walks the
  SmartServer-owned MCP **target registry** (§3.1). For each slot:
  - if it has a live `client`, probe via `client.healthCheck()` → `client.ping()`
    (adapter.ts), a LIVE round-trip;
  - if it has NO healthy client (cold target / dropped), attempt a lazy (re)connect of
    the slot's `config` on cooldown (the `LazyConnectionStrategy._doResolve` pattern),
    then probe. Success → slot healthy + live handle cached; failure → slot stays
    DOWN.
  - The server is READY iff **every** slot is healthy (and LLM ok).
  - **Review P2a — never use `listTools()` for the probe.** `McpClientAdapter.listTools()`
    returns the **cached** catalog after the first success (adapter.ts:47), so a
    monitor on `listTools()` reports READY while the transport is down. Readiness
    MUST use `healthCheck()`/`ping()` (cache-free). If a future probe wants a
    tool-level check, it must bypass/invalidate the catalog cache explicitly.
- Transition handling:
  - `READY → NOT_READY` when a probe finds MCP down (covers "MCP disappeared after
    startup" even with zero traffic).
  - `NOT_READY → READY` when a probe finds MCP healthy again → **resume request
    intake** (the gate in §3.2 starts allowing requests again). This is the
    "після відновлення MCP запускати процес прийому запитів заново" requirement.
- The monitor starts at server `start()`; the first probe establishes initial
  readiness (so "startup with MCP down" yields NOT_READY rather than a false READY).
- It is a **dedicated readiness monitor owned by SmartServer** (resolved — see §6),
  separate from `IMcpConnectionStrategy` (which owns transport reconnect/refresh, a
  different concern; the monitor reads health, it does not drive reconnect).

### 3.5 Session-preserving reconnect (transport, supporting fix)

To honour "don't lose the session" on a transient blip (so a brief drop does NOT
escalate to NOT_READY / a lost tool result):

- `client.ts connect()`: build the HTTP transport with
  `sessionId: this.sessionId ?? this.config.sessionId` so a reconnect **resumes** the
  live server-assigned session.
- `callTool` retry path: if resume-with-session still fails (server dropped the
  session — 404/expired), clear `this.sessionId` and connect fresh once before
  giving up. Only then is it an unavailability error (§3.3).

This keeps transient network flaps invisible (resume, no readiness change), while a
genuine outage still escalates to NOT_READY.

---

## 4. Consumer contract (the observable change)

| Situation | Before | After |
|---|---|---|
| MCP down at startup | server READY, serves tool-blind (or start throws) | server starts **NOT_READY** (no throw), `/health` 503, requests 503 until MCP up |
| worker/subagent MCP down (DAG/stepper) | `/health` 200 (top-level only) | server **NOT_READY** — worker targets are in the registry |
| MCP drops mid-life | silent `(no response)` 200 | in-flight request → **loud error** (non-200 / `Error:`); server flips NOT_READY |
| transient blip (session kept) | reconnect = fresh session, result may be lost | **resume** same session, result preserved, stays READY |
| MCP recovers | stays degraded / manual restart | background probe flips **READY**, intake resumes automatically |
| genuinely empty answer (MCP fine) | `(no response)` | `(no response)` (unchanged — not an error) |

`/health` change: MCP-down moves from `degraded` (200) to a readiness-failing state
(503). (Open §6: keep `degraded` for partial/multi-MCP, or treat any MCP-down as
not-ready — proposed: any configured-MCP-down ⇒ not-ready.)

---

## 5. Files (anticipated)

- `packages/llm-agent/src/...` — `McpError` availability **code(s)** + the shared
  `isMcpUnavailable(err)` classifier (§3.3); `McpUnavailableError` (or `McpError` with
  the code) typed for consumers.
- `packages/llm-agent-mcp/src/adapter.ts` / `client.ts` — tag transport/availability
  failures with the availability code; session-preserving reconnect (§3.5).
- `packages/llm-agent-libs/src/agent.ts` — core tool loop: escalate availability
  errors instead of stringifying them (§3.3).
- `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` — same escalation in
  the pipeline-handler tool loop (§3.3).
- `packages/llm-agent-libs/src/health/health-checker.ts` — readiness derivation over
  the registry, or a new small `readiness` helper.
- `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — the SmartServer
  MCP **target registry** (slots: config + optional live handle; global +
  worker/subagent), readiness field, request gate (incl. streaming split §3.2),
  background readiness monitor (lazy slot reconnect), `buildMcpBridge` fail-loud,
  `(no response)` branch, `/health` readiness mapping, AND
  `connectMcpClientsFromConfig` change: a down-at-boot target is recorded as a DOWN
  slot instead of throwing (so start() comes up NOT_READY).
- `packages/llm-agent-mcp/src/strategies/lazy-connection-strategy.ts` — reuse the
  `Slot` model / `_doResolve` cooldown-reconnect as the registry/monitor mechanism
  (extract or compose; don't duplicate).
- Tests in each touched package.

---

## 6. Open questions (resolve in the plan)

1. **Readiness surface:** reuse `/health` (make MCP-down → 503) **and/or** add a
   dedicated `/ready` (liveness vs readiness split)? Proposed: make `/health`
   readiness-accurate (503 on MCP-down) — minimal, no new endpoint — and document it.
2. **Multi-MCP:** if one of N MCP clients is down — not-ready, or degraded-but-serving
   the others? Proposed: **any configured MCP down ⇒ not-ready** (conservative,
   matches "don't serve tool-blind"); revisit if a partial-serve use-case appears.
3. **Probe interval / backoff:** default 10s; configurable via YAML
   (`mcp.healthIntervalMs`?). The slot lazy-reconnect cooldown
   (`LazyConnectionStrategy` default 30s) is a separate knob — align or keep distinct?
   Proposed: separate; probe interval ≤ cooldown.
4. **Worker probe-connection cost:** for builder-connected `subCfg.mcp` the monitor
   opens its OWN probe-connection per worker target (§3.1). For many workers sharing
   one endpoint this could mean duplicate connections. Proposed: de-dup slots by
   resolved target (url/command) so identical worker targets share one slot.

**Resolved by this/the prior revision (were open):**
- *Readiness source* → SmartServer-owned MCP **target registry** (slots: config +
  optional live handle), covering global **and** worker/subagent targets — NOT
  `agent.healthCheck()`'s top-level `_activeClients`. (§3.1)
- *Cold-MCP startup* → registry built from config; failed connect = DOWN slot, not a
  thrown start; monitor retries. (§3.1 / §2)
- *Worker/subagent MCP contract* → **included** in readiness (target registration);
  builder-connected `subCfg.mcp` covered via a monitor-owned probe-connection. (§3.1)
- *Probe mechanism* → dedicated SmartServer readiness monitor over the registry via
  `healthCheck()`/`ping()`, never cached `listTools()`. (§3.4)

---

## 7. Out of scope

- SAP AI Core 429 throttling (separate; memory `feedback_rate_limit`).
- Per-tool circuit breaking beyond the existing CircuitBreaker.
- Changing the LLM-down semantics (already `unhealthy` + 503).
