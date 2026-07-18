# Debug-trace by area — design

Date: 2026-07-18
Motivation: issue #213 diagnosis needed per-LLM-call request/response content and
per-controller-step decisions, and we had no way to capture them for the
controller path. See [[project_issue213_residual_diagnostics]].
Scope: additive diagnostic capability, off by default.

## Problem — "we have debug, but we can't see the LLM responses"

A content-grained capture channel already exists — `SessionLogger.logStep`
(`packages/llm-agent-libs/src/logger/session-logger.ts:30`) — and it already
records `llm_request_iter_N`, `llm_response_iter_N`, `final_response`,
`mcp_tool_call` for the flat-agent / tool-loop / stepper paths. But:

1. **It is gated by `cfg.logDir`, not a debug flag** — instantiated at
   `http/chat-route-handler.ts:118` with `cfg.logDir || null`
   (`session-logger.ts:13` short-circuits when the dir is null). If `logDir` is
   unset, nothing is captured, and nobody discovers that this is *the* way to see
   responses.
2. **The controller never calls it** — `ControllerCoordinatorHandler` contains
   **zero** `logStep`/`sessionLogger` calls (grep count 0). So on the controller
   path — the one that balloons in #213 — LLM responses are not captured at all,
   even with `logDir` set.
3. **The only controller debug today is `DEBUG_CONTROLLER` → stderr** (`dlog`,
   `controller-coordinator-handler.ts:76`) — decision breadcrumbs
   (classify/run), with **no** response content.

So the capability is in the wrong channel for the controller and behind an
unrelated key. This design closes both holes.

## Constraints (binding)

- **Env-var gated, uniform with existing flags.** Primary switch is a `DEBUG_*`
  environment variable, off by default, consistent in naming and semantics with
  `DEBUG_CONTROLLER` / `DEBUG_SMART_AGENT`. A CLI/config parameter may mirror it,
  but the env var is the expected path. See [[feedback_debug_toggles_env_vars]].
- **Granular, per-area toggles — NOT one master switch.** Each debug concern has
  its own flag so that enabling "LLM responses" does not flood the operator with
  everything else. Existing `DEBUG_CONTROLLER` / `DEBUG_SMART_AGENT` are kept, not
  removed.
- **Build ON existing components.** Reuse `SessionLogger.logStep`; do not add a
  fifth logging channel. See [[feedback_build_on_components_not_bespoke]].
- **Consumer-safe by construction.** The trace carries only step content
  (messages / responses / decisions / usage). Config, API keys,
  `AICORE_SERVICE_KEY`, and auth headers must NEVER flow into `logStep`.
- **Additive / backward-compatible.** No behavior change when the flags are unset.

## Design

### 1. Area flags (env-var, uniform)

A small closed set of independent boolean env-var toggles, each enabling capture
for one area into the shared content channel:

| Env var | Area tag | Captures |
|---|---|---|
| `DEBUG_LLM` | `llm` | Per-LLM-call request (messages + tools) and response (content / tool_calls / finishReason / usage). The #213 gap. |
| `DEBUG_CONTROLLER` | `controller` | (extended) Per-step decisions — phase, replan / retry / reviewer-reject / target-distance + reason — into the content channel, **in addition to** its existing stderr `dlog`. |
| `DEBUG_MCP` | `mcp` | MCP tool call args / result / timing / isError at the MCP boundary. |
| `DEBUG_RAG` | `rag` | Recall / results-RAG queries and the extracts returned into context. |

The set is a **registry** (an area → flag mapping in one module), so adding a new
area later is a single entry — the "whatever else is needed for analysis" case —
not a new channel. A helper `isDebugArea(area): boolean` reads the env var once and
is the single decision point.

`DEBUG_CONTROLLER` keeps its current stderr behavior unchanged (backward-compat);
this design only ADDS content-channel records under the same flag.

### 1a. Area-aware SessionLogger (the gate model — resolves legacy vs granular)

The area filtering lives IN `SessionLogger`, so call sites stay one-liners and one
component owns the decision (build-on-the-component). `logStep` gains an optional
area tag: `logStep(name, data, area?)`. The logger holds an **enabled-areas set**,
decided at construction:

- Constructed from `cfg.logDir` (legacy opt-in) → **all areas enabled** — every
  existing and new `logStep` fires exactly as today. **Backward-compatible.**
- Constructed because a `DEBUG_*` flag is set (no `logDir`) → enabled set = only
  the areas whose flags are on → **granular**: `DEBUG_LLM` alone yields only `llm`
  records, not a flood.
- Neither → the logger is null/no-op as today.

`logStep(name, data, area)` writes iff `area` is in the enabled set (an untagged
call defaults to area `general`, which is enabled only in the legacy `logDir`
mode). Existing meaningful call sites (`llm_request_iter_N`, `mcp_tool_call`, …)
get tagged with their area so they too become granular under the flags, while
staying identical under `logDir`.

### 2. Capture sites (close the coverage gap)

Each site calls `logStep(name, data, area)` on the request's `sessionLogger`; the
logger itself applies the area gate (§1a), so a site is a single tagged call with
no per-site env read. The `name` is also area-prefixed so records are filterable on
disk (e.g. `llm_request_iter_2`, `controller_decision_replan`).

- **LLM I/O (`llm`)** — at the handler's calls to the subagent client, where
  `ctx.options?.sessionLogger` is in scope (the same access pattern as
  `executor.ts:61`), capture the outgoing `messages`+`tools` and the returned
  content/tool_calls/finishReason/usage around each `send(...)`
  (`controller/subagent-client.ts:19-30` is the wrapped call). Keep it at the
  handler level so no `sessionLogger` plumbing into `subagent-client` is needed.
  The flat/tool-loop paths already emit `llm_request_iter_N` /
  `llm_response_iter_N` via `logStep`; this brings the controller to parity.
- **Controller decisions (`controller`)** — at the decision points in
  `controller-coordinator-handler.ts` (the `settle(...)` closure `:954`,
  `phase='awaiting-replan'` transitions `:419/:491/:635/:967/:1201`, attempt-budget
  cut `:831-836`, reviewer unverifiable/verdict `:1274-1329`, target-state
  `:551`), emit a `controller_decision_<kind>` step with the reason.
- **MCP (`mcp`)** — tag the existing `mcp_tool_call` emissions (`agent.ts:1356`,
  `onToolExecuted` `tool-loop-core.ts:228`) with area `mcp`, and add the same
  tagged call on the controller's MCP bridge path so it emits under `DEBUG_MCP`.
- **RAG (`rag`)** — at the controller recall path, emit the recall query + returned
  extracts.

### 3. Sink + gate wiring

- `sessionLogger` already reaches every handler as `ctx.options?.sessionLogger`
  (`interfaces/types.ts:45`; passed at `chat-route-handler.ts:163`; consumed this
  way at `executor.ts:61`). The controller handler has `ctx`
  (`controller-coordinator-handler.ts:215`), so capture sites read
  `ctx.options?.sessionLogger?.logStep(...)` directly — no new plumbing.
- **Enablement independent of `cfg.logDir`:** at the construction site
  (`chat-route-handler.ts:118-119`), the base dir becomes
  `cfg.logDir ?? (anyDebugAreaOn ? DEBUG_TRACE_DIR : null)` (default
  `./.smart-agent-debug/`), and the enabled-areas set is computed per §1a
  (all-areas when from `logDir`, else the on-flags). `cfg.logDir` still wins for
  the dir and forces all-areas (legacy). This is the change to the `SessionLogger`
  construction; the area-set plumbing lives inside `SessionLogger`.
- **Format is unchanged:** numbered JSON files per step under
  `<dir>/session_<id>/req_<ts>_<traceId>/NN_<name>.json` — already correlates
  session / run / traceId / order. Filter by the area-tagged `name`. A consumer
  ships us a trace by zipping one `req_<traceId>` directory.

### 4. Safety

The trace only ever contains what passes through `logStep` — step content
(messages / responses / decisions / usage). Credentials and config never reach
`logStep` and this design adds no config/env/header capture. Business data inside
prompts (ABAP source, table rows) is NOT redacted — it is the consumer's own data
and is needed for debugging; the docs state that the consumer decides whether to
share a trace. No scrubbing pass; safety is by construction (exclusion, not
cleanup).

## Testing

- **Unit** — `isDebugArea(area)` reads each `DEBUG_*` env var correctly (set /
  unset / arbitrary truthy), and the registry maps areas to flags.
- **Unit (the gate)** — area-aware `SessionLogger`: from `logDir` → every area
  (incl. untagged `general`) writes (backward-compat); from `{llm}` only → a
  `logStep(_, _, 'llm')` writes but `logStep(_, _, 'mcp')` and an untagged call do
  NOT; from empty → no-op.
- **Unit (the site)** — `subagent-client.send` calls `logStep` with area `llm`
  carrying messages + response; the decision points call `logStep` with area
  `controller` and the reason. Assert the tagged call happens; filtering is the
  logger's job (tested above), so these don't re-read env.
- **Unit (backward-compat)** — a controller decision with `DEBUG_CONTROLLER` set
  still fires the existing stderr `dlog` AND now the tagged `logStep`.
- **Integration** — `DEBUG_LLM` set, `cfg.logDir` unset → step files appear under
  the `DEBUG_TRACE_DIR` default and contain only `llm`-area records; all flags and
  `logDir` unset → no dir created, no `logStep` writes.
- **Safety assertion** — written step data never contains the configured api key /
  service key / auth header.

## Architecture Principles check

1. Build ON existing components — reuses `SessionLogger.logStep`, no new channel.
2. The app is the example — the server wires the flags; capture lives in the libs.
3. Interfaces — capture sites depend on the existing `sessionLogger?: {logStep}`
   shape (`types.ts:45`); the optional `area?` third arg is additive (existing
   two-arg callers keep working). The area gate is internalized in `SessionLogger`,
   extending the component rather than adding a parallel one.
4. ISP — no interface grows for consumers; the area registry is a focused helper.
5. Strategies — n/a (env-var config, not a consumer variation point).
6. File size — one small `debug-areas` module (registry + `isDebugArea`); capture
   sites are one-line guards.
7. Don't break components — additive; unset flags = today's behavior exactly.

## Out of scope (YAGNI)

Single consolidated trace file; network/OTLP export; a viewer UI; redaction/
scrubbing of business content; per-area verbosity levels. Files + flags only.
