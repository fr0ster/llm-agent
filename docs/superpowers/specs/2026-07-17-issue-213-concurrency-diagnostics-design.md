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
existing `config_warning` event via `this.warn(msg)` (`smart-server.ts:1992-1994`).
A silent shared-client fallback is the exact thing that made this issue expensive;
that config fact must be visible with no env flag.

The warning message MUST name the disabling reason, not just the outcome —
otherwise the reporter learns "a warning happened" with nothing actionable, and
the deliberate `agent.mcpSharedClient: true` opt-out is indistinguishable from an
accidental fallback. Required shape — the reasons are the BARE keys of
`isolation.disabledReasons` (§3), comma-joined, never re-formatted as `key=value`:

```
MCP per-session isolation OFF (shared client across sessions) — reason: mcpSharedClient
MCP per-session isolation OFF (shared client across sessions) — reason: hasReadyClients, mcpSeamInjected
```

The reason list comes from `isolation.disabledReasons` and is not composed inline
here. The values behind those keys are already in the same `mcp_isolation` event, so
restating them in the message would only invite the two to disagree.

`mcpSharedClient` is reported as the raw config value (`this.cfg.agent?.mcpSharedClient`,
`undefined` → `null` in JSON) so an unset value is distinguishable from `false`.

### 2. Per-request line (behind `DEBUG_CONTROLLER`)

The controller already has an env-gated debug channel: `dlog`
(`controller-coordinator-handler.ts:75-76`, `DEBUG_CONTROLLER`).

**The `runId` is not available at classify time.** For `cls.kind === 'fresh'` the
run is minted *after* the branch, at `controller-coordinator-handler.ts:308-309`
(`resetRun(bundle, prompt); bundle.runId = mintRunId()`); the same holds for the
expired-terminal fall-through (`:296-297`). In the reporter's exact repro every
cookieless request is a NEW session, so `hydrateBundle` returns an empty bundle and
`bundle.runId` would be `undefined` at that point — always. A single line logged
right after `classifyRequest` would therefore carry no run identity in precisely
the case being diagnosed.

So emit **two** lines:

1. immediately after `classifyRequest` (`controller-coordinator-handler.ts:279-285`),
   before any branch returns early:

   ```
   [controller] classify session=<sessionId> cls=<cls.kind>
   ```

2. once the run identity is settled — after the `fresh` / expired-replay mint
   (`:296-297`, `:308-309`) and on the `resume` path where `bundle.runId` is already
   populated:

   ```
   [controller] run session=<sessionId> run=<bundle.runId> cls=<cls.kind>
   ```

Line 1 alone is the discriminator below (it is the one that always fires, including
on the early-return `replay` / `not-found` branches); line 2 adds run identity for
correlating a run across its phases.

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
  /** Which fact(s) disabled isolation — empty when `perSession` is true. Ordered
   *  as listed here: 'mcpSharedClient' | 'hasReadyClients' | 'mcpSeamInjected'
   *  | 'noMcpConfig'. */
  disabledReasons: string[];
};
```

`disabledReasons` is part of the PAYLOAD, not composed inline at the call site: the
warning message must be assertable by the unit test, and the reason belongs in the
structured event anyway (the reporter reads the JSON line, not our prose). The
`config_warning` message is then rendered from it:

```ts
if (!isolation.perSession && isolation.hasMcpConfig)
  this.warn(
    `MCP per-session isolation OFF (shared client across sessions) — reason: ${isolation.disabledReasons.join(', ')}`,
  );
```

`noMcpConfig` never reaches the warning (guarded by `hasMcpConfig`) but is reported
in the event, so "no MCP at all" is distinguishable from "MCP present, isolation
lost".

It composes the two existing gates rather than restating their logic.

**Composing the gates is not by itself enough to prevent drift.** The wiring at
`smart-server.ts:1348-1352` calls `shouldIsolateMcpPerSession` *separately*; if the
log payload were computed alongside it, the two could diverge on a later edit and
the diagnostic would lie. So the wiring MUST CONSUME the same value it logs — the
single call site becomes the source of truth:

```ts
const isolation = describeMcpIsolation({
  hasReadyClients,
  hasMcpConfig: !!this.cfg.mcp,
  mcpSeamInjected: this._mcpSeamInjected,
  mcpSharedClient: this.cfg.agent?.mcpSharedClient,
});
log(isolation);
if (!isolation.perSession && isolation.hasMcpConfig) this.warn(/* reason */);
// ...
buildPerSessionMcpClients: isolation.perSession
  ? () => buildSessionMcpClients(this.cfg.mcp)
  : undefined,
```

`mcpFromYaml` remains available as `isolation.mcpFromYaml` for the
`yamlBuilderConnect` decision (`smart-server.ts:1186`), so that call site is
unchanged in behavior.

Scope limit, stated honestly: `buildSessionLifecycle` restates the rule a THIRD
time as `usePerSession = !!opts.buildPerSessionMcpClients && !opts.mcpSharedClient`
(`session-lifecycle/index.ts:106-107`). This design does not collapse that one —
it receives both inputs from the same resolved decision, so the extra guard is
redundant-but-consistent, and removing it is a behavior-adjacent change that does
not belong in an observability-only PR.

## Testing

- **Unit** on `describeMcpIsolation` — a table covering EVERY cause of a fallback,
  since each is an independent way isolation goes off silently:

  | case | inputs | expect |
  |---|---|---|
  | pure YAML | `hasMcpConfig: true`, rest false/unset | `perSession: true` |
  | ready clients | `hasReadyClients: true`, `hasMcpConfig: true` | `perSession: false` |
  | empty-array trap | same as above (`cfg.mcpClients: []` → presence, not length) | `perSession: false` |
  | seam injected | `mcpSeamInjected: true`, `hasMcpConfig: true` | `perSession: false` |
  | deliberate opt-out | `hasMcpConfig: true`, `mcpSharedClient: true` | `perSession: false` |
  | no MCP at all | `hasMcpConfig: false` | `perSession: false`, `disabledReasons: ['noMcpConfig']` |

  Each fallback case also asserts `disabledReasons` names the responsible fact
  (`mcpSharedClient` / `hasReadyClients` / `mcpSeamInjected` / `noMcpConfig`), which
  is what the `config_warning` message is rendered from.

  **Whether a warning FIRES is not assertable at this level** — `describeMcpIsolation`
  reports facts and reasons, not a warning decision; the guard
  `if (!isolation.perSession && isolation.hasMcpConfig)` lives in `SmartServer` (§1).
  Adding a `shouldWarn` / `warningMessage` to the payload to make it unit-testable
  would put a second, competing decision in the report — so the "no MCP → silent"
  behavior is asserted by integration case 4 below instead.

- **Integration** on `SmartServer` with a fake `cfg.log`:
  1. pure YAML `mcp:` → one `mcp_isolation` event with `perSession: true`, and **no**
     `config_warning`;
  2. ready clients + `mcp:` → `perSession: false` **and** a `config_warning` naming
     `hasReadyClients`;
  3. injected `connectMcp` seam + `mcp:` → `perSession: false` **and** a
     `config_warning` naming `mcpSeamInjected`. The seam path is one of the more
     expensive ambiguity points (it is also a plausible H1 trigger in the field), so
     it earns an integration case and not just a unit row;
  4. **no `mcp:` block at all** → `mcp_isolation` with `perSession: false` and
     `disabledReasons: ['noMcpConfig']`, and **no** `config_warning` — a
     deployment that runs without MCP must not be nagged. This is where the
     `hasMcpConfig` guard is actually asserted.

**The event alone is not enough.** Consuming `isolation.perSession` at the call site
(§3) makes drift unlikely, but a test that only reads the log still passes while the
wiring below it is broken — the event would be right and the sessions would still
share a client. So the `perSession: true` integration case MUST also assert the
observable consequence:

- acquire TWO sessions from the built lifecycle and assert they receive **distinct**
  `IMcpClient` instances (the `perSession: false` cases assert the **same** instance).

This is hermetic and cheap: `buildSessionMcpClients` builds wrappers that connect
LAZILY on first `callTool`/`listTools`
(`mcp/build-session-mcp-clients.ts:41-45`), so two sessions can be acquired against a
fake `mcp.url` without any MCP server existing. Reach the private wiring with the
established white-box cast pattern already used for exactly this kind of test
(`__tests__/mcp-single-connect.test.ts:44-53`) rather than adding a DI seam for
tests only.

With the consequence asserted, these tests catch a regression of the gate itself —
not merely of the log text.

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
2. one 2-way concurrent run with `DEBUG_CONTROLLER=1`, enough to show the
   `classify session=/cls=` line (and the follow-on `run=` line) for both requests.

That closes the diagnosis without another round of speculation.
