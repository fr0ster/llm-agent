# MCP Fail-Loud Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task ends in exactly one commit; run the pinning tests and the SCOPED lint gate before committing.

**Goal:** Stop the controller pipeline from silently degrading to `(no response)` when an MCP call fails because the MCP SERVER is unavailable — make it fail LOUD, using a consumer-swappable classification strategy (interfaces + DI), without touching/breaking the core MCP components.

**Architecture:** The MCP server is either available or not; which tools it offers is a protocol concern (`tools/list`). A transport-level failure (`fetch failed` / HTTP 404/403/502/503 on the endpoint / `ping` fails) = the server is unavailable → the run must fail loud, NOT feed the error to the executor as tool output (which the controller currently does → empty content → the route substitutes `(no response)` at chat-route-handler.ts:408). The flat/linear/dag path already fails loud (`classifyToolResult` → escalate on `isMcpUnavailable`); the controller path does not. This plan makes the availability decision a focused, consumer-owned STRATEGY (`IMcpFailureClassifier`) built ON existing components (`isMcpUnavailable`, `IMcpClient.healthCheck()` = MCP `ping`), applied **at the `buildMcpBridge` boundary** (where the structured `McpError` still exists — the controller-handler boundary is too late because the bridge already stringifies non-unavailable errors) AND in the flat `classifyToolResult`. The **default** classifier is **error-based** (`isMcpUnavailable`, no per-call round-trip); the interface exposes an optional `probeHealth` **seam** so a consumer CAN implement a ping-confirming classifier — the default is NOT health-probing. It is wired via DI that reaches the controller path: the classifier is threaded through `IPipelineContext` → the controller factory/handler AND into `buildMcpBridge`, not only the generic `SmartAgentBuilder`. It also extends `toMcpError` so a transport HTTP error (incl. 404) is recognized as unavailable.

**Tech Stack:** TypeScript (ESM `.js`), `node:test` + `tsx`, Biome. Package ownership: `@mcp-abap-adt/llm-agent` = `McpError` / `isMcpUnavailable` / `MCP_UNAVAILABLE_CODES` + the new `IMcpFailureClassifier` interface; `@mcp-abap-adt/llm-agent-mcp` = `toMcpError` (`error-mapping.ts`) + `DefaultMcpFailureClassifier`; `@mcp-abap-adt/llm-agent-libs` = flat `classifyToolResult` + shared tool-loop core + `SmartAgent`/builder DI; `@mcp-abap-adt/llm-agent-server-libs` = `buildMcpBridge` (in smart-server) + the controller.

## Global Constraints

- **Do NOT touch/break core components.** `MCPClientWrapper`, `McpClientAdapter`, the connection strategies, `IMcpClient` are extended ADDITIVELY only. The fix is a NEW focused strategy interface + a default implementation built ON existing helpers (`isMcpUnavailable`, `healthCheck()`), NOT bespoke glue in the controller/app.
- **Consumer choice via interfaces + DI + strategies.** The availability-classification is a variation point the consumer owns: a new `IMcpFailureClassifier` (ISP — a new focused interface, do NOT grow an existing one), injected via DI. **Default classifier = error-based** (`isMcpUnavailable`, no per-call health round-trip); the interface EXPOSES an optional `probeHealth` seam so a consumer can implement a ping-confirming classifier (their server's health method is already behind `IMcpClient.healthCheck()`). **Do NOT call it a "health-aware default".**
- **DI must REACH the controller path (not just the generic builder).** The controller pipeline builds `ControllerCoordinatorHandler` inside `controller.ts` from `ctx` (before `createAgentBuilder().withStepperCoordinator(...)`), so `SmartAgentBuilder.withMcpFailureClassifier(...)` alone does NOT reach it. Thread the classifier through `IPipelineContext` (`mcpFailureClassifier?`) → `IServerPipelineContext` → `ControllerFactoryDeps` / the controller plugin, AND into `buildMcpBridge` (the server's `callMcp`). The generic builder seam is additional, not the sole path.
- **Classification happens at the `buildMcpBridge` boundary, NOT the controller handler.** `buildMcpBridge` (smart-server.ts:565, the `this.callMcp` at 1790) currently hardcodes `isMcpUnavailable` and returns non-unavailable errors as a STRING before the handler sees them — so classifying in the handler is too late. Pass the classifier INTO `buildMcpBridge`; it classifies `listTools`/`callTool` errors there (on `unavailable` → throw; else → error text). The controller handler then only needs to SURFACE the thrown unavailable error loudly.
- **Both paths share ONE classifier** (flat `classifyToolResult` + the server `buildMcpBridge`) — do NOT duplicate the decision logic.
- **MCP-unavailable ⇒ fail loud** (escalate/terminal error surfaced), NEVER a silent `(no response)`. A genuine tool-level error (server up, tool returned an error) still feeds back to the LLM (unchanged).
- Additive/backward-compatible; default behavior unchanged for the flat path (its default classifier == today's `isMcpUnavailable`, plus the broadened 404 recognition). ESM `.js`, TS strict, `noUnusedLocals`, `I`-prefixed interfaces, Biome exit 0.
- **SCOPED lint gate per task:** `npx @biomejs/biome check --write <changed files>` → `npm run lint:check` **exit 0**.
- **Commit ONLY this task's files:** `git status --short`, explicit `git add`.
- **Release 20.3.0 is HELD** until this ships (user chose to fix fail-loud before publishing). After merge: bump 20.4.0 (or fold into an un-tagged 20.3.0 — decide at release time).

---

## File Structure

- `packages/llm-agent/src/interfaces/mcp-failure-classifier.ts` — **(Task 2, create)** `IMcpFailureClassifier` + `McpFailureKind` (+ barrel export).
- `packages/llm-agent-mcp/src/error-mapping.ts` — **(Task 1)** `toMcpError` broadened (transport HTTP incl. 404 ⇒ unavailable). `packages/llm-agent/src/interfaces/types.ts` — **(Task 1)** add the new unavailable code (e.g. `MCP_HTTP_404`) to `MCP_UNAVAILABLE_CODES` if used (`isMcpUnavailable` lives here too).
- `packages/llm-agent-mcp/src/default-mcp-failure-classifier.ts` — **(Task 2, create)** default impl (uses `isMcpUnavailable`; optional health probe) + barrel export.
- `packages/llm-agent-libs/src/pipeline/handlers/escalate-if-unavailable.ts` — **(Task 4)** `classifyToolResult` → async, consumes the injected classifier (default preserves today's behavior).
- `packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts` — **(Task 4/5)** `await classifyToolResult(...)` @~349; add `mcpFailureClassifier?` to `IExecuteToolBatchArgs` (the SHARED core, used by BOTH callers).
- `packages/llm-agent-libs/src/agent.ts` — **(Task 5)** `SmartAgentDeps.mcpFailureClassifier?` + pass it at the direct `executeToolBatchWithHeartbeat` call (~1280) so DIRECT SmartAgent runs are covered (not just pipeline runs).
- `packages/llm-agent/src/interfaces/pipeline-plugin.ts` — **(Task 5)** add `mcpFailureClassifier?: IMcpFailureClassifier` to `IPipelineContext`; `default-pipeline.ts`/`PipelineDeps` carry it into `ctx` → `IExecuteToolBatchArgs`.
- `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — **(Task 3)** `buildMcpBridge(clients, classifier = default)` classifies `listTools`/`callTool` errors (replacing hardcoded `isMcpUnavailable`); call site stays `buildMcpBridge(clients)`. **(Task 5)** `this.callMcp` passes the instance classifier + populate `ctx.mcpFailureClassifier` from `BuildAgentDeps`/the builder (default `DefaultMcpFailureClassifier`).
- `packages/llm-agent-server-libs/src/pipelines/controller.ts` + `packages/llm-agent-server-libs/src/factories/controller-factory.ts` — **(Task 5)** thread `ctx.mcpFailureClassifier` into `ControllerFactoryDeps` so the handler surfaces a thrown unavailable error loudly.
- `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` — **(Task 3)** SURFACE a thrown unavailable `McpError` from `deps.callMcp` loudly (`abortTerminal`), instead of degrading to empty/`(no response)`.
- `packages/llm-agent-libs/src/builder.ts` — **(Task 5)** `withMcpFailureClassifier(...)` DI seam (additional programmatic path; the primary threading is via `IPipelineContext`).
- Tests per task. **Task 6** = live acceptance (no commit).

---

### Task 1 — Broaden `toMcpError`: transport HTTP errors (incl. 404) ⇒ unavailable

Extend the existing component (additively) so a transport-level HTTP failure is classified unavailable. The MCP server being reachable-but-returning-an-HTTP-error (404 route gone / any 4xx/5xx on the endpoint) = unavailable; a tool-level error comes back via the protocol (200 + result.isError), never as an HTTP status.

**Files:** modify `packages/llm-agent-mcp/src/error-mapping.ts` (`toMcpError`) + `packages/llm-agent/src/interfaces/types.ts` (`MCP_UNAVAILABLE_CODES` — add `MCP_HTTP_404` if used); test `packages/llm-agent-mcp/src/__tests__/error-mapping.test.ts` (create/extend).

**Steps:**
- [ ] **Read** `error-mapping.ts` `toMcpError` (the signature-matching cascade) + `types.ts` `MCP_UNAVAILABLE_CODES`.
- [ ] **Failing test first:** `toMcpError(new Error('Streamable HTTP error: Error POSTing to endpoint: 404 Not Found: Requested route (...) does not exist.')).code` is an UNAVAILABLE code (e.g. `MCP_HTTP_404` or `MCP_TRANSPORT`), and `isMcpUnavailable(that)` is `true`. Add: a generic `Error POSTing to endpoint`/`Streamable HTTP error` wrapper (any status) → unavailable. Keep the existing guard: a plain tool error message (`'invalid table name'`) → `MCP_ERROR` (NOT unavailable), and a domain phrase (`'transport request X not found'`, `'business network'`) → NOT unavailable (do NOT regress the anti-false-positive comment's intent).
- [ ] Run → FAILS (404 currently maps to `MCP_ERROR`).
- [ ] **Implement:** add a signature branch matching the streamable-http transport-error wrapper (`m.includes('error posting to endpoint')` or `m.includes('streamable http error')`) → an unavailable code; add `'http 404'`/`'404 not found'` if you prefer per-status. Add the new code to `MCP_UNAVAILABLE_CODES`. Keep it distinctive (NO bare `not found` / `transport` / `network`).
- [ ] Run tests → GREEN (+ existing error-mapping tests). `npm run build` → SCOPED lint → commit: `fix(mcp): classify transport HTTP errors (incl. 404 route-gone) as MCP-unavailable`.

---

### Task 2 — `IMcpFailureClassifier` interface + error-based default (health-probe seam)

**Files:** create `packages/llm-agent/src/interfaces/mcp-failure-classifier.ts` + barrel export; create `packages/llm-agent-mcp/src/default-mcp-failure-classifier.ts` + barrel export; test `packages/llm-agent-mcp/src/__tests__/default-mcp-failure-classifier.test.ts`.

**Interface (Produces):**
```ts
// packages/llm-agent/src/interfaces/mcp-failure-classifier.ts
import type { McpError } from './types.js';
export type McpFailureKind = 'unavailable' | 'tool-error';
/** Consumer-owned strategy: decide whether a failed MCP tool call means the
 *  SERVER is unavailable (fail loud) or is a tool-level error (feed back to the
 *  LLM). `probeHealth` (optional) lets an impl authoritatively confirm via the
 *  server's health method (MCP `ping`, behind IMcpClient.healthCheck). */
export interface IMcpFailureClassifier {
  classify(
    error: McpError,
    probeHealth?: () => Promise<boolean>,
  ): Promise<McpFailureKind>;
}
```

**Steps:**
- [ ] Create the interface + `export * from './mcp-failure-classifier.js';` in the interfaces barrel. `npm run build`.
- [ ] **Failing test first** (`default-mcp-failure-classifier.test.ts`): `new DefaultMcpFailureClassifier().classify(mkErr('MCP_NOT_CONNECTED'))` → `'unavailable'`; `.classify(mkErr('MCP_ERROR'))` → `'tool-error'`; with a `probeHealth` that resolves `false` and a `MCP_ERROR`, the default STILL returns `'tool-error'` (default ignores probeHealth — error-based) OR, if you implement health-confirm, returns `'unavailable'` (pick one; the DEFAULT should NOT add a health round-trip per call unless the error is ambiguous — keep default = `isMcpUnavailable(error) ? 'unavailable' : 'tool-error'`, and DOCUMENT that a health-probing classifier is a consumer opt-in). Also a test that a custom classifier using `probeHealth` returns `'unavailable'` when probe is false.
- [ ] **Implement** `DefaultMcpFailureClassifier` (in llm-agent-mcp): `async classify(error) { return isMcpUnavailable(error) ? 'unavailable' : 'tool-error'; }` — built ON the existing `isMcpUnavailable` helper. Barrel-export it (mirror `NoopMcpRequestHeadersStrategy`).
- [ ] Run tests → GREEN. `npm run build` → SCOPED lint → commit: `feat(mcp): IMcpFailureClassifier + DefaultMcpFailureClassifier (isMcpUnavailable-based, health-probe seam)`.

---

### Task 3 — Classify in `buildMcpBridge` + controller surfaces the thrown unavailable loudly (THE fix)

Two parts, ONE commit: (a) `buildMcpBridge` uses the injected classifier (not hardcoded `isMcpUnavailable`) so a consumer's policy governs which errors are "unavailable"; (b) the controller SURFACES a thrown unavailable `McpError` loudly instead of degrading to `(no response)`.

**Files:** modify `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`buildMcpBridge` @565 + `this.callMcp` @1790) and `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (the `deps.callMcp` throw at ~1285) + `packages/llm-agent-server-libs/src/factories/controller-factory.ts` + `packages/llm-agent-server-libs/src/pipelines/controller.ts` (thread the classifier from `ctx`). Tests: a `buildMcpBridge` unit test + the controller confirming test.

**Steps:**
- [ ] **Read** `buildMcpBridge` (565) — it calls `client.listTools()`/`client.callTool()` and `if (isMcpUnavailable(err)) throw err; else return err.message`. Read the `deps.callMcp` call in the handler (~1285) + how the controller surfaces terminal errors (`abortTerminal`/`escalate`/the yield) + the existing `harness({...})` in `controller-coordinator-handler.test.ts`. Determine whether a thrown `McpError` from `deps.callMcp` currently propagates loud OR is swallowed to empty (the confirming test settles this).
- [ ] **Failing test first — buildMcpBridge classifier:** `buildMcpBridge([client], customClassifier)` where `client.callTool` rejects/returns an error the CUSTOM classifier maps to `'unavailable'` → the bridge THROWS (not returns text); with the default classifier and a non-unavailable error → returns the text. (Assert the classifier is consulted, not hardcoded `isMcpUnavailable`.)
- [ ] **Failing test first — controller surface:** create `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-mcp-failloud.test.ts`. Case A: a run whose `deps.callMcp` REJECTS with `new McpError('...fetch failed...', 'MCP_NOT_CONNECTED')` during the executor step → assert the terminal result is a LOUD failure (NOT empty/`(no response)`): the run yields `ok:false` with an MCP-unavailable error OR reaches a terminal abort carrying the reason. Case B: `deps.callMcp` returns a non-unavailable tool-error STRING → the executor receives it as tool feedback (unchanged). Run → Case A FAILS if the throw is currently swallowed (documents the bug); if it already surfaces loud, Case A passes and this part is a guard.
- [ ] **Implement:**
  - `buildMcpBridge(clients, classifier: IMcpFailureClassifier = new DefaultMcpFailureClassifier())` — the classifier is an OPTIONAL param with a default so existing callers/tests (`buildMcpBridge([client])`) compile UNCHANGED (backward-compatible; no call-site churn). Replace the hardcoded `isMcpUnavailable(err)` checks (both the `listTools` and `callTool` error branches) with `(await classifier.classify(err)) === 'unavailable' ? throw err : return err.message` (the bridge is already async). **Leave the `this.callMcp` (1790) call site as `buildMcpBridge(clients)` (uses the default)** — passing a stored/injected classifier is Task 5 (do NOT reference `this._mcpFailureClassifier` here; it does not exist yet). This keeps Task 3 self-contained.
  - Controller handler: ensure a thrown `McpError` from `deps.callMcp` at ~1285 is CAUGHT and surfaced loud (`abortTerminal` with `'MCP server unavailable: ' + err.message`), not swallowed. If the confirming test shows it already surfaces loud (propagates to a loud terminal), keep the guard test and make no handler change; if it degrades, add the catch+`abortTerminal`. Do NOT reference `ctx.mcpFailureClassifier` (Task 5) — the handler only surfaces the throw; it needs no classifier itself.
- [ ] Run both new tests → GREEN. Existing controller + server-libs tests → still green. `npm run build` → SCOPED lint → commit: `fix(mcp/controller): classify MCP failures in buildMcpBridge via IMcpFailureClassifier + surface unavailable loudly — no more silent (no response)`.

---

### Task 4 — `classifyToolResult` goes ASYNC through the classifier (shared by both callers)

`IMcpFailureClassifier.classify` returns a `Promise`, so `classifyToolResult` MUST become async and its caller MUST await it. Currently it is SYNC (`tool-loop-core.ts:349` calls it inline). This task changes the signature + updates every caller/test.

**Files:** modify `packages/llm-agent-libs/src/pipeline/handlers/escalate-if-unavailable.ts` (`classifyToolResult` → async) and `packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts` (await it at ~349, inside the results loop of `executeToolBatchWithHeartbeat` — that loop is already async); test alongside.

**Steps:**
- [ ] **Read** `classifyToolResult(res)` (returns `{ escalate }` when `isMcpUnavailable(res.error)`) and its call site `tool-loop-core.ts:349` (sync, inside the `for (const r of results)` loop). Note: the loop is already `async` (it awaits elsewhere), so awaiting the classifier is safe.
- [ ] **Change the signature:** `classifyToolResult(res: ToolRes, classifier: IMcpFailureClassifier = new DefaultMcpFailureClassifier()): Promise<ToolResultDecision>` — the unavailable decision now goes through `await classifier.classify(res.error)`; default classifier == today's `isMcpUnavailable`, so behavior is UNCHANGED for existing callers. Update the `tool-loop-core.ts:349` call to `const decision = await classifyToolResult(res)` — **using the DEFAULT classifier only** (do NOT reference a threaded classifier yet; that arrives in Task 5 via `IExecuteToolBatchArgs`). This keeps Task 4 self-contained: it builds + commits green on its own (async + default), and Task 5 later passes the injected classifier as the 2nd arg.
- [ ] **Failing test first:** with a custom classifier that returns `'unavailable'` for a `MCP_ERROR`, `await classifyToolResult(res, custom)` escalates; with the default, a `MCP_ERROR` does NOT escalate (unchanged); a `MCP_NOT_CONNECTED` escalates by default. Update ALL existing `classifyToolResult`/tool-loop callers + tests to `await`.
- [ ] Run tests → GREEN. Existing flat/linear/dag + tool-loop tests still green. `npm run build` → SCOPED lint → commit: `refactor(pipeline): classifyToolResult is async via IMcpFailureClassifier (default = today's isMcpUnavailable)`.

---

### Task 5 — DI threading to BOTH tool-loop callers + controller + bridge + builder seam

The classifier must reach the CONTROLLER path (P1b) AND the shared `executeToolBatchWithHeartbeat` core used by BOTH `ToolLoopHandler` (pipeline) AND `SmartAgent._runStreamingToolLoop` (the DIRECT path, `agent.ts:1280`, outside `PipelineContext`). Threading it only via `ctx` would miss direct SmartAgent runs. So thread it through `IExecuteToolBatchArgs` (the shared core's args) and pass it from BOTH callers — the pipeline caller from `ctx.mcpFailureClassifier`, the direct caller from `SmartAgentDeps.mcpFailureClassifier`.

**Files:** modify `packages/llm-agent/src/interfaces/pipeline-plugin.ts` (`IPipelineContext.mcpFailureClassifier?`), the shared-core args type `IExecuteToolBatchArgs` (in/near `tool-loop-core.ts` — add `mcpFailureClassifier?`), `packages/llm-agent-libs/src/agent.ts` (`SmartAgentDeps.mcpFailureClassifier?` + pass it at the `executeToolBatchWithHeartbeat` call ~1280), the `ToolLoopHandler` call site (pass `ctx.mcpFailureClassifier`), `packages/llm-agent-libs/src/pipeline/default-pipeline.ts` / `PipelineDeps` (carry it into `ctx`), `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (store instance classifier from `BuildAgentDeps`/builder ONLY (no YAML), populate `ctx.mcpFailureClassifier`, pass to `buildMcpBridge` + `SmartAgentDeps`), `packages/llm-agent-server-libs/src/pipelines/controller.ts`, `packages/llm-agent-libs/src/builder.ts` (`withMcpFailureClassifier(...)`). Tests.

**Steps:**
- [ ] **Read** `agent.ts:~1280` (the direct `executeToolBatchWithHeartbeat` call) + the `ToolLoopHandler` call + `IExecuteToolBatchArgs` + `SmartAgentDeps`/`PipelineDeps` shapes, to map the two threading routes. `npm run build`.
- [ ] Add `mcpFailureClassifier?: IMcpFailureClassifier` to: `IPipelineContext` (`pipeline-plugin.ts:37`, inherited by `IServerPipelineContext`), `IExecuteToolBatchArgs` (shared core), `SmartAgentDeps`, `PipelineDeps`, and `BuildAgentDeps` (the programmatic `buildAgent(deps)` seam — so an embedding consumer injects it). In `executeToolBatchWithHeartbeat`, update the Task-4 call to `await classifyToolResult(res, args.mcpFailureClassifier)` (now passing the injected one; undefined → Task 4's default). Both callers pass it: `ToolLoopHandler` from `ctx.mcpFailureClassifier`; `SmartAgent._runStreamingToolLoop` from `this.deps.mcpFailureClassifier`.
- [ ] **Config scope:** the classifier is a CODE strategy (like `IMcpRequestHeadersStrategy`) — **DI/programmatic only, NO YAML strategy registry**. Do NOT add it to `SmartServerConfig`/the YAML parse. `smart-server` obtains it from `BuildAgentDeps`/the builder (default `DefaultMcpFailureClassifier` when unset). State this in the smart-server wiring.
- [ ] **Failing test first:** (a) builder — `builder.withMcpFailureClassifier(custom)` → resolved deps/context carry `custom`; default → `DefaultMcpFailureClassifier`. (b) direct SmartAgent — a `SmartAgent` built with a custom classifier + a tool that returns a `MCP_ERROR` the custom classifier maps `unavailable` → the direct tool-loop escalates (proves the DIRECT path is covered, not just the pipeline). (c) smart-server — `ctx.mcpFailureClassifier` populated (default) reaches `buildMcpBridge`.
- [ ] **Implement:** builder `private _mcpFailureClassifier?` + `withMcpFailureClassifier(c): this` (mirror @444/@453); smart-server stores the classifier (from `BuildAgentDeps`/the builder ONLY — NO SmartServerConfig/YAML; default `DefaultMcpFailureClassifier`), populates `ctx.mcpFailureClassifier`, threads it into `SmartAgentDeps` + `buildMcpBridge`; the pipeline threads `ctx.mcpFailureClassifier` → `IExecuteToolBatchArgs`. Confirm BOTH callers pass a classifier (default when unset).
- [ ] Run tests → GREEN, incl. the DIRECT-SmartAgent case. `npm run build` (all packages). SCOPED lint → commit: `feat(di): thread IMcpFailureClassifier to both tool-loop callers (pipeline ctx + direct SmartAgent) + builder seam`.

---

### Task 6 — Acceptance (fail-loud proven — controller test + live)

No code change. **Primary proof = the controller confirming test (Task 3), NOT the Task 1 error-mapping test** (Task 1 only proves classification, not that the controller stopped degrading).

**Steps:**
- [ ] Confirm the Task 3 `controller-mcp-failloud.test.ts` (Case A: unavailable → loud; Case B: tool-error → fed back) is present + green — this is the authoritative proof the controller no longer degrades to `(no response)`.
- [ ] **Live check:** build, start the controller config against a mid-failing / unreachable MCP (point `mcp.url` at a 404/closed endpoint, OR use `.run/skills-review-github.yaml` when :3001 is unstable). Send a controller request that needs MCP. Assert the delivered response is a LOUD error (explicit MCP-unavailable message / error status), NOT the literal `(no response)`; server stays responsive. If a clean induced live failure is hard, a route-level test (drive the chat route with a mocked unavailable MCP → assert a loud error body, not `(no response)`) is an acceptable substitute. Record results. No commit.

---

## Notes

- `isMcpUnavailable`/`MCP_UNAVAILABLE_CODES` (llm-agent) + `toMcpError` (llm-agent-mcp `error-mapping.ts`) are shared helpers — extending their recognition (Task 1) fixes the classification at the source for BOTH paths, and is "extend the component", not app glue.
- The health-probe (`IMcpClient.healthCheck()` = MCP `ping`) is the authoritative availability signal, BUT the DEFAULT classifier is **error-based** (fast, no per-call round-trip) — NOT health-probing. The interface exposes an optional `probeHealth` seam so a CONSUMER can implement a ping-confirming classifier; the default does not call it. (No "health-aware default".)
- Classification lives at the `buildMcpBridge` boundary (structured `McpError` available) + `classifyToolResult`; the controller handler only SURFACES a thrown unavailable error loudly.
- Does NOT touch the #222 timeout work.
