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
  appears. Survives a cold MCP.
- **Spec-first**, then implement in reviewed PRs.

---

## 3. Design

### 3.1 Readiness state machine (SmartServer)

A single server-level readiness signal, derived from MCP (and LLM) health:

```
READY      ⟺  llm ok  AND  every configured MCP client ok
NOT_READY  ⟺  otherwise
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

#### Readiness source — a SmartServer-owned MCP client registry (NOT `agent.healthCheck()`)

> **Review P1b.** `agent.healthCheck()` only probes the top-level agent's
> `_activeClients` (agent.ts:269/471). Worker/subagent MCP clients live in
> `subCfg.mcpClients` and the per-worker cache (smart-server.ts:2052 / 2446) and are
> **invisible** to the top-level agent. "every configured MCP client ok" therefore
> cannot be derived from `agent.healthCheck()`.

The readiness signal is computed by SmartServer over an **explicit registry of every
MCP client it owns**:
- shared/global MCP clients (`connectMcpClientsFromConfig` / the `connectMcp` seam),
  and
- worker/subagent MCP clients (DI `subCfg.mcpClients` + builder-connected
  `subCfg.mcp`, captured in the worker cache).

SmartServer registers each client into this registry as it builds them (global at
`start()`, workers as their handles are built/cached) and deregisters on close. The
readiness monitor (§3.4) probes **this registry**, so worker/subagent MCP outages are
covered. (LLM health stays via the existing path.) Builder-connected `subCfg.mcp`
clients that SmartServer cannot reach a handle for are an explicit gap — see §6.

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

- A periodic monitor (interval configurable, default e.g. 10s) probes the
  SmartServer-owned MCP client registry (§3.1) via each client's
  `healthCheck()` — which calls `client.ping()` (adapter.ts), a LIVE round-trip.
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
| MCP down at startup | server READY, serves tool-blind | server **NOT_READY**, `/health` 503, requests 503 until MCP up |
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
  MCP-client **registry** (global + worker/subagent), readiness field, request gate
  (incl. streaming split §3.2), background readiness monitor, `buildMcpBridge`
  fail-loud, `(no response)` branch, `/health` readiness mapping.
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
   (`mcp.healthIntervalMs`?).
4. **Builder-connected `subCfg.mcp` coverage (review P1b residue):** worker MCP given
   as DI `subCfg.mcpClients` is registry-reachable; worker MCP that the
   SmartAgentBuilder connects internally from `subCfg.mcp` may not expose a handle to
   SmartServer (smart-server.ts comments: "connection is the builder's job"). Decide:
   surface those handles up for registry inclusion, or document readiness as covering
   "SmartServer-reachable MCP clients" only (and rely on §3.3 in-flight escalation for
   the rest). Proposed: expose the handles where cheap; otherwise document the scope.

**Resolved by this revision (were open):**
- *Probe mechanism* → dedicated SmartServer readiness monitor probing the owned MCP
  registry via `healthCheck()`/`ping()` (NOT `agent.healthCheck()`, NOT cached
  `listTools()`). See §3.1 / §3.4.
- *Readiness source* → explicit SmartServer-owned MCP client registry (global +
  worker/subagent), not the top-level agent's `_activeClients`. See §3.1.

---

## 7. Out of scope

- SAP AI Core 429 throttling (separate; memory `feedback_rate_limit`).
- Per-tool circuit breaking beyond the existing CircuitBreaker.
- Changing the LLM-down semantics (already `unhealthy` + 503).
