# Issue #213 — concurrency diagnostics (observability only)

Date: 2026-07-17
Issue: #213 (residual concurrency defect on v20.6.0, after #219 and #226)
Scope: **observability only — zero behavior change**

## Problem

On v20.6.0 the reporter still sees, under 2-way concurrency on the controller
tool-use path (2 simultaneous non-streaming `POST /v1/chat/completions`,
cookieless):

| Run | reqA | reqB |
|---|---|---|
| 1 | ok, ~14K tokens | `(no response)`, usage 0 |
| 2 | ok, ~14K tokens | answered but ~74K tokens (ballooned) |
| 3 | `(no response)`, usage 0 | ok, ~14K tokens |

A single request alone is always correct and bounded (~14K). No MCP errors are
logged. The reporter's hypothesis is "shared in-flight state at the
controller/pipeline level".

## What the code says

A full trace of `POST /v1/chat/completions` → `_withSession`
(`smart-server.ts:2379-2433`) → `SessionRegistry.acquire` → `buildSessionAgent`
→ `ControllerCoordinatorHandler.execute`
(`controller/controller-coordinator-handler.ts:214`) **does not support the
reporter's hypothesis**:

- The controller handler holds no mutable instance field (only `deps`,
  `controller-coordinator-handler.ts:212`). Blackboard, budget and bundle are
  hydrated per request from the sid-keyed backend. `runId` is minted per run
  (`:222-224`). No module-scope mutable state.
- The RAG/recall path is session-keyed at every hop: `KnowledgeRag` closes over
  `sessionId` for every `put`/`query` (`llm-agent-libs/src/rag/knowledge-rag.ts:84,
  95-111`); the JSONL backend writes `sessions/<sid>/knowledge.jsonl`
  (`jsonl-knowledge-backend.ts:34-36`) with a per-`sid` serialization chain
  (`:44-58`); the semantic index is `bySession`
  (`embedder-knowledge-index.ts:54, 79`).
- Usage attribution is per-`requestId` with a depth counter
  (`llm-agent-libs/src/logger/session-request-logger.ts:108-180`); the controller
  reads it back via `getSummary(meta.traceId)`
  (`controller-coordinator-handler.ts:238-241`).

Two hypotheses survive.

### H1 — per-session MCP isolation (#226) is silently OFF for this deployment

The gate engages only on the pure YAML `mcp:` path:

```
serverOwnsMcpConnection = !hasReadyClients && hasMcpConfig && !mcpSeamInjected
                                            (smart-server.ts:1175-1179)
shouldIsolateMcpPerSession = mcpFromYaml && !mcpSharedClient
                                            (mcp/build-session-mcp-clients.ts:16-20)
```

Any of the following turns isolation off **silently, with no log line**:
`cfg.mcpClients` / `deps.mcpClients` present (even `[]` — the gate is on
presence, not length, `smart-server.ts:1161-1166`), any plugin contributing MCP
clients (`smart-server.ts:1129-1132`), an injected `connectMcp` seam
(`smart-server.ts:782`), or `agent.mcpSharedClient: true`. The lifecycle then
falls back to `return opts.mcpClients` (`session-lifecycle/index.ts:106-112`) —
one shared client for every session, i.e. pre-#226 semantics.

Supporting evidence: the #226 commit message (`764e668e`) records that the
shared-client opt-out reproduces **~71K ballooning** vs **~15K** isolated. That
is the reporter's 74K/14K to within noise. A shared client produces both symptoms
at once and without errors: one request absorbs the other's tool results
(balloon), the other receives none and finalizes empty.

### H2 — two concurrent requests actually share a `sessionId`

The durable bundle is keyed per session, latest-wins (`session-bundle.ts:26-60`).
Fingerprint-resume (`run-scope.ts:151-157`) then makes run B adopt run A's
`runId`, and B surfaces A's terminal with `usageNow()` structurally 0 →
`(no response)` + usage 0.

**Note:** session-scoped bundle and fingerprint-resume are *intentional* (stateless
suspend/resume). Making the bundle runId-aware would break resume; it is
explicitly **not** in scope. H2 would mean the reporter's cookieless assumption is
wrong, not that the design is.

## Goal

Discriminate H1 from H2 with a single run on the reporter's deployment, without
changing any behavior.

## Design

Two log sources, both through existing components. No new interfaces, no new
abstractions.

### 1. Startup event `mcp_isolation` (always on)

The server already carries a structured log channel — `SmartServerConfig.log`
(`smart-server.ts:251`), which the CLI writes as JSON lines to `smart-server.log`
(`llm-agent-server/src/smart-agent/cli.ts:241-248`). The reporter already has that
file. There is an existing precedent for a config-fact event: `config_warning`
(`smart-server.ts:1993`).

At the point where the decision is already computed (`smart-server.ts:1175-1179`),
emit:

```json
{ "event": "mcp_isolation", "mcpFromYaml": true, "hasReadyClients": false,
  "hasMcpConfig": true, "mcpSeamInjected": false, "mcpSharedClient": null,
  "perSession": true }
```

Additionally, when `perSession === false` **and** `hasMcpConfig === true`, emit the
existing `config_warning` event. A silent shared-client fallback is the exact thing
that made this issue expensive; that config fact must be visible with no env flag.

`mcpSharedClient` is reported as the raw config value (`this.cfg.agent?.mcpSharedClient`,
`undefined` → `null` in JSON) so an unset value is distinguishable from `false`.

### 2. Per-request line (behind `DEBUG_CONTROLLER`)

The controller already has an env-gated debug channel: `dlog`
(`controller-coordinator-handler.ts:75-76`, `DEBUG_CONTROLLER`). Immediately after
`classifyRequest` (`controller-coordinator-handler.ts:279-285`), emit one line:

```
[controller] run session=<sessionId> run=<bundle.runId> cls=<cls.kind>
```

This is the discriminator:

- Two concurrent requests reporting **different** `sessionId`, with startup
  `perSession: false` → **H1 confirmed**; the gate itself is the bug.
- Two concurrent requests reporting the **same** `sessionId` → the cookieless
  assumption is wrong → **H2 live**.

This line is per-request noise, hence env-gated; the startup event is a one-shot
config fact, hence always on.

### 3. `describeMcpIsolation` — the payload as a pure function

So the event is not a log nobody verifies, the payload is built by a pure function
placed beside the gates it describes, in
`mcp/build-session-mcp-clients.ts` (90 lines — the module that already holds
`shouldIsolateMcpPerSession` and `serverOwnsMcpConnection`):

```ts
export function describeMcpIsolation(o: {
  hasReadyClients: boolean;
  hasMcpConfig: boolean;
  mcpSeamInjected: boolean;
  mcpSharedClient?: boolean;
}): {
  event: 'mcp_isolation';
  mcpFromYaml: boolean;
  hasReadyClients: boolean;
  hasMcpConfig: boolean;
  mcpSeamInjected: boolean;
  mcpSharedClient: boolean | null;
  perSession: boolean;
};
```

It composes the two existing gates rather than restating their logic, so the
reported `perSession` cannot drift from the wiring at `smart-server.ts:1348-1352`.

## Testing

- **Unit** on `describeMcpIsolation`: a table of inputs against expected
  `perSession`, including the trap case `cfg.mcpClients: []` (presence, not length
  → `hasReadyClients: true` → `perSession: false`) and `mcpSharedClient: true` on
  the YAML path → `perSession: false`.
- **Integration** on `SmartServer` with a fake `cfg.log`, covering exactly the two
  configurations that discriminate the hypotheses:
  1. pure YAML `mcp:` → one `mcp_isolation` event with `perSession: true`, and **no**
     `config_warning`;
  2. ready clients + `mcp:` → `perSession: false` **and** a `config_warning`.

These assert the gate's resolved decision, not merely the log text, so the test
catches a regression of the gate itself.

## Architecture Principles check

1. **Build on existing components** — reuses `cfg.log`, the `config_warning` event
   and `dlog`; no bespoke logger, no glue in the server.
2. **The app IS the example** — `describeMcpIsolation` lands in the library beside
   its own gates; the server only calls it.
3. **Interfaces** — none added; nothing new to depend on.
4. **ISP** — no interface grows.
5. **Strategies** — no new variation point; this is a config fact, not a consumer choice.
6. **File size** — ~15 lines added to an existing 90-line focused module.
7. **Don't break components** — purely additive; behavior unchanged, only new log lines.

## Out of scope (deliberately)

- **runId-aware bundle key** — would break the intentional stateless resume
  (`run-scope.ts:151-157`).
- **Removing the silent `?? ''`** at `controller-coordinator-handler.ts:1699` (which
  durably commits an empty terminal as `{kind:'success', answer:''}`) — a real
  latent bug, but a behavior change; it belongs in the fix PR once the cause is
  proven.
- **Fixing the gate** (per-session provisioning for ready-client/seam paths) — the
  likely fix under H1, deferred until the diagnosis is proven rather than assumed.
- `ctx.callMcp` → `_sharedMcpClients` (`smart-server.ts:1878`): a live shared
  seam for non-controller pipelines, but the controller builds its bridge from
  `ctx.mcpClients` (`src/pipelines/controller.ts:139-144`), so it is not this
  trigger.

## Follow-up (not code)

After merge + release, ask the reporter for:

1. the `mcp_isolation` line from their `smart-server.log`;
2. one 2-way concurrent run with `DEBUG_CONTROLLER=1`, enough to show
   `session=`/`run=`/`cls=` for both requests.

That closes the diagnosis without another round of speculation.
