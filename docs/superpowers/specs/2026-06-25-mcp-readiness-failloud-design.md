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

### 3.2 Request gate (fail-loud, replaces silent `(no response)`)

On the pipeline request paths (`/v1/chat/completions`, `/v1/messages`, streaming and
non-streaming):

- **Before dispatch:** if NOT_READY → respond **HTTP 503** with an explicit OpenAI-
  shaped error body, e.g.
  `{"error":{"type":"service_unavailable","message":"MCP unavailable — server not ready"}}`.
  Do NOT run the pipeline. (Streaming: emit a single error event then close, no
  `[DONE]` masking.)
- **`(no response)` fallback (smart-server.ts:3632):** keep `(no response)` ONLY for
  a genuinely empty-but-successful turn. When the run degraded due to MCP
  unavailability, the component throws (next section) → `result.ok === false` →
  the existing `Error: ${result.error.message}` path (3633) carries it. We also map
  that to a non-200 status where the response shape allows.

### 3.3 In-flight fail-loud from the pipeline component

- **`buildMcpBridge` (smart-server.ts:945–966):** distinguish *"this client does not
  own the tool"* from *"this client errored"*. Today both fall through to
  `continue` / `Tool not found`. New: if `listTools()` returns `!ok` because of a
  **transport/availability** error (not a clean empty list), treat MCP as
  unavailable → throw a typed `McpUnavailableError` (or return a Result the caller
  fails on) rather than masking the tool as not-found. A genuine "no client owns
  this tool name" stays `Tool not found`.
- The thrown error propagates out of the coordinator/pipeline component as an
  orchestrator error → the consumer sees a real failure (the embedding consumer can
  catch it; the HTTP surface returns non-200 / `Error: …`).
- Side effect: such a failure flips the server NOT_READY (§3.1).

### 3.4 Background health probe (recovery + proactive detection)

- A periodic monitor (interval configurable, default e.g. 10s) calls the existing
  `agent.healthCheck()` (cheap — it already pings LLM/RAG/MCP) or a narrower MCP
  `listTools()` probe.
- Transition handling:
  - `READY → NOT_READY` when a probe finds MCP down (covers "MCP disappeared after
    startup" even with zero traffic).
  - `NOT_READY → READY` when a probe finds MCP healthy again → **resume request
    intake** (the gate in §3.2 starts allowing requests again). This is the
    "після відновлення MCP запускати процес прийому запитів заново" requirement.
- The monitor starts at server `start()`; the first probe establishes initial
  readiness (so "startup with MCP down" yields NOT_READY rather than a false READY).
- Reuse/extend the existing `IMcpConnectionStrategy` / `PeriodicConnectionStrategy`
  infra where it fits; otherwise a small dedicated readiness monitor owned by
  SmartServer. (Open: pick one in the plan — see §6.)

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

- `packages/llm-agent-libs/src/health/health-checker.ts` — readiness derivation
  (mcp-down ⇒ not-ready signal), or a new small `readiness` helper.
- `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — readiness field,
  request gate, background probe wiring, `buildMcpBridge` fail-loud, `(no response)`
  branch.
- `packages/llm-agent/src/interfaces/*` — `McpUnavailableError` (or reuse `McpError`
  with a code) so the component error is typed for consumers.
- `packages/llm-agent-mcp/src/client.ts` — session-preserving reconnect.
- Tests in each touched package.

---

## 6. Open questions (resolve in the plan)

1. **Readiness surface:** reuse `/health` (make MCP-down → 503) **and/or** add a
   dedicated `/ready` (liveness vs readiness split)? Proposed: make `/health`
   readiness-accurate (503 on MCP-down) — minimal, no new endpoint — and document it.
2. **Probe mechanism:** extend `PeriodicConnectionStrategy` vs a dedicated SmartServer
   readiness monitor? Proposed: dedicated monitor calling `agent.healthCheck()` (one
   owner, simplest).
3. **Multi-MCP:** if one of N MCP clients is down — not-ready, or degraded-but-serving
   the others? Proposed: **any configured MCP down ⇒ not-ready** (conservative,
   matches "don't serve tool-blind"); revisit if a partial-serve use-case appears.
4. **Probe interval / backoff:** default 10s; configurable via YAML
   (`mcp.healthIntervalMs`?).

---

## 7. Out of scope

- SAP AI Core 429 throttling (separate; memory `feedback_rate_limit`).
- Per-tool circuit breaking beyond the existing CircuitBreaker.
- Changing the LLM-down semantics (already `unhealthy` + 503).
