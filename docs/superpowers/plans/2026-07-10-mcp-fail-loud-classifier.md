# MCP Fail-Loud Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task ends in exactly one commit; run the pinning tests and the SCOPED lint gate before committing.

**Goal:** Stop the controller pipeline from silently degrading to `(no response)` when an MCP call fails because the MCP SERVER is unavailable — make it fail LOUD, using a consumer-swappable classification strategy (interfaces + DI), without touching/breaking the core MCP components.

**Architecture:** The MCP server is either available or not; which tools it offers is a protocol concern (`tools/list`). A transport-level failure (`fetch failed` / HTTP 404/403/502/503 on the endpoint / `ping` fails) = the server is unavailable → the run must fail loud, NOT feed the error to the executor as tool output (which the controller currently does → empty content → the route substitutes `(no response)` at chat-route-handler.ts:408). The flat/linear/dag path already fails loud (`classifyToolResult` → escalate on `isMcpUnavailable`); the controller path does not. This plan makes the availability decision a focused, consumer-owned STRATEGY (`IMcpFailureClassifier`) built ON existing components (`isMcpUnavailable`, `IMcpClient.healthCheck()` = MCP `ping`), consumed by BOTH paths, wired via a builder DI seam (default = a health-aware classifier). It also extends `toMcpError` so a transport HTTP error (incl. 404) is recognized as unavailable.

**Tech Stack:** TypeScript (ESM `.js`), `node:test` + `tsx`, Biome. Packages: `@mcp-abap-adt/llm-agent` (new `I*` interface + `toMcpError`/`isMcpUnavailable` live here), `@mcp-abap-adt/llm-agent-mcp` (default classifier + `toMcpError`), `@mcp-abap-adt/llm-agent-libs` (flat `classifyToolResult` + builder DI seam), `@mcp-abap-adt/llm-agent-server-libs` (controller consume + escalate).

## Global Constraints

- **Do NOT touch/break core components.** `MCPClientWrapper`, `McpClientAdapter`, the connection strategies, `IMcpClient` are extended ADDITIVELY only. The fix is a NEW focused strategy interface + a default implementation built ON existing helpers (`isMcpUnavailable`, `healthCheck()`), NOT bespoke glue in the controller/app.
- **Consumer choice via interfaces + DI + strategies.** The availability-classification is a variation point the consumer owns: a new `IMcpFailureClassifier` (ISP — a new focused interface, do NOT grow an existing one), injected via a builder seam mirroring `withMcpConnectionStrategy`/`withMcpRequestHeadersStrategy`. Default = the health-aware classifier; consumers can swap it (e.g. their server's custom health method — already behind `IMcpClient.healthCheck()`).
- **Both paths share ONE classifier** (flat `classifyToolResult` + the controller) — do NOT duplicate the decision logic.
- **MCP-unavailable ⇒ fail loud** (escalate/terminal error surfaced), NEVER a silent `(no response)`. A genuine tool-level error (server up, tool returned an error) still feeds back to the LLM (unchanged).
- Additive/backward-compatible; default behavior unchanged for the flat path (its default classifier == today's `isMcpUnavailable`, plus the broadened 404 recognition). ESM `.js`, TS strict, `noUnusedLocals`, `I`-prefixed interfaces, Biome exit 0.
- **SCOPED lint gate per task:** `npx @biomejs/biome check --write <changed files>` → `npm run lint:check` **exit 0**.
- **Commit ONLY this task's files:** `git status --short`, explicit `git add`.
- **Release 20.3.0 is HELD** until this ships (user chose to fix fail-loud before publishing). After merge: bump 20.4.0 (or fold into an un-tagged 20.3.0 — decide at release time).

---

## File Structure

- `packages/llm-agent/src/interfaces/mcp-failure-classifier.ts` — **(Task 2, create)** `IMcpFailureClassifier` + `McpFailureKind` (+ barrel export).
- `packages/llm-agent/src/interfaces/types.ts` — **(Task 1)** `toMcpError`/`MCP_UNAVAILABLE_CODES` broadened (transport HTTP incl. 404). NOTE: `toMcpError` actually lives in `packages/llm-agent-mcp/src/error-mapping.ts` — confirm and edit there; `MCP_UNAVAILABLE_CODES`/`isMcpUnavailable` are in `types.ts`.
- `packages/llm-agent-mcp/src/default-mcp-failure-classifier.ts` — **(Task 2, create)** default impl (uses `isMcpUnavailable`; optional health probe) + barrel export.
- `packages/llm-agent-libs/src/pipeline/handlers/escalate-if-unavailable.ts` — **(Task 4)** `classifyToolResult` consumes the injected classifier (default preserves today's behavior).
- `packages/llm-agent-libs/src/builder.ts` — **(Task 5)** `withMcpFailureClassifier(...)` DI seam.
- `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` — **(Task 3)** consume the classifier at the `deps.callMcp` boundary → escalate on `unavailable`.
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

### Task 2 — `IMcpFailureClassifier` interface + default (health-aware) implementation

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

### Task 3 — Controller consumes the classifier → fail loud on `unavailable` (THE fix)

**Files:** modify `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (the `deps.callMcp` boundary ~1285 + the deps type ~138 to accept a classifier) and its factory wiring (`packages/llm-agent-server-libs/src/factories/controller-factory.ts`). This task writes its own confirming test (TDD, failing-first) — it reproduces the bug then fixes it in one commit.

**Steps:**
- [ ] **Read** the `deps.callMcp` call (~1285) + how the controller surfaces terminal errors (`abortTerminal`/`escalate`/the yield) + the existing `harness({...})` in `controller-coordinator-handler.test.ts` (how it drives execute→runStep to a terminal and stubs `deps.callMcp`). `deps.callMcp` currently returns `Promise<string>` and THROWS on `isMcpUnavailable` (via `buildMcpBridge`).
- [ ] **Failing test first (the confirming test — reproduces the bug):** create `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-mcp-failloud.test.ts`. Case A: a run whose `deps.callMcp` REJECTS with `new McpError('...fetch failed...', 'MCP_NOT_CONNECTED')` (unavailable) during the executor step → assert the terminal result is a LOUD failure (NOT empty/`(no response)`): the run yields `ok:false` with an MCP-unavailable error OR reaches a terminal abort carrying the MCP-unavailable reason (pick the assertion matching the surfacing contract you read). Case B: `deps.callMcp` REJECTS with `new McpError('bad input', 'MCP_ERROR')` (non-unavailable) → the executor receives it as tool feedback (NOT escalated) — tool-error behavior preserved. Run → Case A FAILS on current code (documents the bug).
- [ ] **Implement:** add `mcpFailureClassifier?: IMcpFailureClassifier` to the controller deps (default `new DefaultMcpFailureClassifier()`), wire it through `controller-factory.ts`. Wrap the `deps.callMcp(name, args)` call: on a thrown `McpError` (or a McpError-shaped failure), `const kind = await classifier.classify(err, () => probeHealth())` (probeHealth optional — thread a health probe if a client handle is reachable; else omit). If `kind === 'unavailable'` → `await this.abortTerminal(ctx, sessionId, bundle, 'MCP server unavailable: ' + err.message, now, terminalTtlMs, usageNow())` (surface loud) and return terminal. Else → feed the error text back as the tool result (current behavior). Do NOT change the timeout work.
- [ ] Run the new test → GREEN (Case A loud, Case B fed back). Run existing controller tests → still green. `npm run build` → SCOPED lint → commit: `fix(controller): fail loud on MCP-unavailable via IMcpFailureClassifier — no more silent (no response)`.

---

### Task 4 — Flat/linear/dag path consumes the SAME classifier (unify, no behavior change)

**Files:** modify `packages/llm-agent-libs/src/pipeline/handlers/escalate-if-unavailable.ts` (`classifyToolResult` accepts/uses the classifier; default preserves today's `isMcpUnavailable` behavior); test alongside.

**Steps:**
- [ ] **Read** `classifyToolResult(res)` — it returns `{ escalate }` when `isMcpUnavailable(res.error)`. Refactor so the unavailable decision goes through an `IMcpFailureClassifier` (injected; default = `DefaultMcpFailureClassifier`). Since the default == `isMcpUnavailable`, behavior is UNCHANGED for existing callers (backward-compatible) — but now a consumer's classifier governs BOTH paths.
- [ ] **Failing test first:** with a custom classifier that returns `'unavailable'` for a `MCP_ERROR`, `classifyToolResult` escalates; with the default, a `MCP_ERROR` does NOT escalate (unchanged). Then implement (thread the classifier param, default it).
- [ ] Run tests → GREEN. Existing flat/linear/dag tests still green. `npm run build` → SCOPED lint → commit: `refactor(pipeline): classifyToolResult goes through IMcpFailureClassifier (default = today's isMcpUnavailable)`.

---

### Task 5 — Builder DI seam `withMcpFailureClassifier`

**Files:** modify `packages/llm-agent-libs/src/builder.ts` (setter mirroring `withMcpConnectionStrategy` @444; thread the classifier into the flat pipeline + the controller deps); test.

**Steps:**
- [ ] **Read** `withMcpConnectionStrategy` (444) + `withMcpRequestHeadersStrategy` (453) for the pattern + where the pipeline/controller deps are assembled.
- [ ] **Failing test first:** `builder.withMcpFailureClassifier(custom)` → the resolved pipeline/controller deps carry `custom`; without calling it, the default `DefaultMcpFailureClassifier` is used. (Mirror an existing builder-seam test.)
- [ ] **Implement:** `private _mcpFailureClassifier?: IMcpFailureClassifier` + `withMcpFailureClassifier(c): this`; thread it into both the flat pipeline (classifyToolResult) and the controller deps; default to `new DefaultMcpFailureClassifier()`.
- [ ] Run tests → GREEN. `npm run build` → SCOPED lint → commit: `feat(builder): withMcpFailureClassifier DI seam (default DefaultMcpFailureClassifier)`.

---

### Task 6 — Live acceptance (fail-loud proven end-to-end)

No code change.

**Steps:**
- [ ] Build. Start the controller config against an UNREACHABLE / mid-failing MCP (either point `mcp.url` at a 404/closed endpoint, or use the real `.run/skills-review-github.yaml` and induce a failure). Send a controller request that requires MCP. Assert the delivered response is a LOUD error (an explicit MCP-unavailable message / an error status), NOT the literal `(no response)`, and the server stays responsive.
- [ ] (If a clean induced-failure is hard live) rely on the Task 1 unit test as the primary proof + a best-effort live check. Record results. No commit.

---

## Notes

- `toMcpError`/`isMcpUnavailable` are shared helpers (lightweight, in llm-agent) — extending their recognition (Task 2) fixes the classification at the source for BOTH paths, and is "extend the component", not app glue.
- The health-probe (`IMcpClient.healthCheck()` = MCP `ping`) is the authoritative availability signal; the DEFAULT classifier stays error-based (fast, no per-call round-trip) but the interface exposes `probeHealth` so a consumer can implement a ping-confirming classifier. This keeps consumer choice open without imposing a round-trip by default.
- Does NOT touch the #222 timeout work.
