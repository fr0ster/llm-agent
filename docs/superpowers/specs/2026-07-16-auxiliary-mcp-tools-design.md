# IAuxiliaryMcpTools — pipeline-level auxiliary/service MCP tools

**Status:** design (approved in brainstorm 2026-07-16)
**Goal:** A focused, consumer-swappable ISP seam through which a pipeline contributes
stateless *auxiliary/service* MCP tools (first tool: `wait`) into the tool-selection
catalog and the `callMcp` execution bridge — always present (even MCP-less), composing
with the per-step `perStepTimeoutMs`/`AbortSignal` control shipped in #224, and adding
**no new logic or glue** to the `smart-server.ts` / controller-handler monoliths: the only
touch to `smart-server.ts` is the same minimal additive DI field + `buildServerCtx`
conditional-spread already used for `stepExecutionControl` (see §3.4); all composition logic
lives in a new `compose-auxiliary.ts` module.

---

## 1. Motivation

Live testing of the controller (#224) surfaced a livelock class: an **async write/activate**
step (e.g. `Update and activate corrected CDS view entity DDL`) where the executor verifies
the result immediately, sees "not yet settled," and loops on `tool_calls` until the per-step
budget cuts it. The fix instinct — *give the operation time to settle before verifying* —
needs a way for the plan to **wait**.

Rather than a new controller step KIND (an engine/controller change), we expose waiting as a
**tool** the LLM selects like any other. This keeps the engine MCP-agnostic (it hardcodes no
tool names; the consumer gnostifies via tools/skills), and reuses the existing executor
tool-loop, signal plumbing, and tool-selection. The **seam is designed to be usable by any
pipeline** (the composition is generic), but **v1 wires the default `wait` only in the
controller** (our example, where the livelock arose); other pipelines opt in later by composing
the seam in their own `build()`. See §7.

**RAG is explicitly OUT of scope of this seam.** RAG already has its own component
(`IRag` / `IRagEditor` with `upsert`/`deleteById`/`clear`, `KnowledgeBackend` with
`put`/`list`/`deleteSession`). Folding RAG operations into the auxiliary seam would violate ISP
and open an LLM-driven-RAG-mutation risk surface. If RAG-as-tools is ever wanted, it is a
*separate* seam owned by the RAG component.

## 2. The two halves of the rework

The feature is two parts; the spec **implements only the first** (agnostic capability). The
second (gnostic guidance) is a consumer artifact, captured here so it is not forgotten.

| Part | What | Where it lives | In this spec? |
|------|------|----------------|---------------|
| Capability | `IAuxiliaryMcpTools` + `wait` tool | `llm-agent` (interface) + `llm-agent-mcp` (impl) | **YES** |
| Guidance | Skill "for async activate: decompose into `activate → wait → verify` as separate steps" | consumer skills-RAG (Claude-plugin format, runtime; e.g. sap-skills — GPL, NOT our MIT tree) | **NO** (consumer repo) |

The `wait` tool alone is inert for the livelock: without the guidance skill the executor still
verifies *inside* the activate step and livelocks. The controller planner **already** has a
skills-recall hook (`skillsRecall` in `controller.ts`, woven into create-plan/replan), so a
consumer skill reaches the planner with **no engine change**. The engine ships the agnostic
capability; the consumer ships the domain knowledge of when to use it.

## 3. Architecture

### 3.1 Interface (`@mcp-abap-adt/llm-agent`)

A **narrow** interface — deliberately NOT `extends IMcpClient`:

```ts
export interface IAuxiliaryMcpTools {
  listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>>;
}
```

- **No `healthCheck`** and **outside the fail-loud classifier**: auxiliary tools are in-process;
  "unavailable" does not apply to them. An auxiliary-tool error is always a *tool-level* error
  (text fed back to the LLM), **never** escalated as MCP-unavailability — the 20.4.0 fail-loud
  path (`IMcpFailureClassifier`) is not run on the auxiliary branch.
- `McpTool`, `McpToolResult`, `McpError`, `CallOptions`, `Result` are the existing contracts.

The interface lives at the bottom of the dependency order so every layer can depend on it.

### 3.2 Default implementation (`@mcp-abap-adt/llm-agent-mcp/src/auxiliary/`)

- `DefaultAuxiliaryMcpTools` — holds a list of `{ def: McpTool; handler }` entries; `listTools`
  returns the defs; `callTool` routes by name to the matching handler (unknown name → tool-level
  `McpError`, not thrown as unavailable).
- `makeWaitTool(maxSeconds: number)` — returns the `wait` entry:
  - `def.name = 'wait'`; `def.inputSchema` is a real JSON Schema (`LlmTool.inputSchema` is
    `Record<string, unknown>` fed verbatim into the tool definition — NOT a TS type):
    ```json
    {
      "type": "object",
      "properties": { "seconds": { "type": "number", "minimum": 0 } },
      "required": ["seconds"],
      "additionalProperties": false
    }
    ```
  - `def.description` (English, drives semantic selection AND teaches usage):
    *"Pause for the given number of seconds before continuing. Use after an asynchronous
    create/activate operation, before verifying, to let the system settle. Maximum `<max>`
    seconds."*
  - handler: `await cancelableDelay(clamp(seconds, maxSeconds) * 1000, options?.signal)`; returns
    a text result `"Waited <clamped>s"` (or `"Waited <clamped>s (requested N, capped at max)"`
    when clamped).
- `cancelableDelay(ms, signal?)` — a `setTimeout`-based promise that **rejects on `signal`
  abort** (removing its own timer on settle/abort). It does NOT swallow abort — abort must
  propagate so the controller's existing discriminator handles it (see §4).

Package placement (respects `server-libs → libs → {mcp, rag} → llm-agent`): interface in
`llm-agent`; `DefaultAuxiliaryMcpTools` + `makeWaitTool` + `cancelableDelay` in
`llm-agent-mcp/src/auxiliary/` (natural home — this package already owns the in-process /
`embedded` MCP mechanism). A dedicated new package is deferred (YAGNI) until there are enough
auxiliary tools to justify it.

### 3.3 Composition (`@mcp-abap-adt/llm-agent-server-libs/src/mcp/compose-auxiliary.ts`)

A small focused module (NOT appended to `smart-server.ts` / the handler). Two functions:

- `composeAuxiliaryBridge(aux, domainBridge): callMcp` — returns a
  `callMcp(name, args, signal?): Promise<string>` matching the existing bridge contract
  (`buildMcpBridge` and the controller/factory `callMcp` return **text**, not a `Result`;
  see `controller.ts:288`). It:
  1. If `name` is auxiliary-owned (in `aux.listTools()`), calls `aux.callTool(name, args,
     { signal })` and **maps its `Result<McpToolResult, McpError>` to the string contract**:
     `ok` → `typeof content === 'string' ? content : JSON.stringify(content)`;
     `!ok` → `error.message` (tool-level text — the domain classifier / fail-loud is **not**
     run on the auxiliary branch). An abort **rejection** is NOT mapped — it propagates (see §4).
  2. Otherwise delegates to `domainBridge(name, args, signal)` unchanged.
  Auxiliary is checked **first** (aux-first precedence; collisions are rejected at build — §3.4).
- `composeAuxiliarySelect(aux, selectTools)` — wraps the pipeline's `selectTools(query, k,
  options)` so the auxiliary tool defs (`aux.listTools()`) are **merged into every selection
  result** (deduped by name, aux appended). Auxiliary tools are a small fixed utility set that
  should always be in scope for the executor, so they are **always included** rather than
  semantically ranked — this also makes them work MCP-less (domain `selectTools` returns `[]` →
  wrapped result is just the aux defs). This avoids needing an upsert into `toolsRag`:
  `IToolsRagHandle` exposes only `query`/`lookup` (no write), and the domain catalog is
  vectorized at startup from `client.listTools()` — a path we deliberately do not touch.

`buildMcpBridge` and `IToolsRagHandle` in `smart-server.ts` are **unchanged**; both the aux-first
dispatch and the aux-in-selection behavior are wrappers over the pipeline's existing
`callMcp` and `selectTools`.

### 3.4 DI slot and wiring at pipeline creation

- `IPipelineContext.auxiliaryMcpTools?: IAuxiliaryMcpTools` and
  `BuildAgentDeps.auxiliaryMcpTools?: IAuxiliaryMcpTools` — additive optional fields, threaded
  via the same conditional-spread pattern as `stepExecutionControl` / `toolLoopContextStrategyFactory`.
- **Contributed at pipeline creation** (in the plugin's `build()`), consumer-swappable:
  ```ts
  const aux =
    ctx.auxiliaryMcpTools ?? new DefaultAuxiliaryMcpTools([makeWaitTool(maxSeconds)]);
  await assertNoAuxCollision(aux, ctx.toolsRag);     // fail-loud at build (see below)
  const callMcp = composeAuxiliaryBridge(aux, buildMcpBridge(mcpClients, ctx.mcpFailureClassifier));
  const selectTools = composeAuxiliarySelect(aux, baseSelectTools); // aux defs merged into results
  ```
  The controller (our example) contributes the default `wait` at build; the consumer overrides
  the whole provider via `ctx.auxiliaryMcpTools`. Other pipelines opt in by doing the same at
  their `build()` (out of scope for v1 beyond the seam being available).
- Always present, even MCP-less: with no domain MCP, `mcpClients` is empty, but `aux` is still
  composed → `wait` is selectable and callable.
- **Collision handling — fail-loud at build.** Because aux-first makes a same-named domain tool
  unreachable, `async assertNoAuxCollision(aux, ctx.toolsRag)` runs (awaited) at build. It first
  resolves the aux names: `const listed = await aux.listTools();` — on `!listed.ok` it throws a
  build error surfacing `listed.error` (our in-process provider should never fail to list; a
  failure is a real bug, not silently skipped). Then for each aux name it checks the **sync**
  catalog `ctx.toolsRag.lookup(name)` (`IToolsRagHandle` is **non-optional** on
  `IPipelineContext` — pipeline-plugin.ts:50 — and the server always supplies it, defaulting to
  the `EMPTY_TOOLS_RAG` sentinel via `server-context.ts:113`; its `lookup` returns `undefined` for
  every name). A defined result throws a clear config error (`auxiliary tool '<name>' collides
  with a connected MCP tool — rename the auxiliary tool`), so the consumer renames rather than
  silently shadowing a domain tool. No domain catalog (MCP-less) → `EMPTY_TOOLS_RAG.lookup(...)`
  returns `undefined` → no collision. This keeps the bridge wrapper free of a logger / domain
  catalog (the objection to "warn inside the wrapper"): the check is a deterministic build-time
  gate with the domain catalog and throw available.

## 4. Data flow (`wait`, end-to-end)

1. **Build:** `aux = ctx.auxiliaryMcpTools ?? DefaultAuxiliaryMcpTools([makeWaitTool(max)])`;
   `composeAuxiliarySelect` wraps `selectTools` (aux defs always merged in);
   `composeAuxiliaryBridge` wraps the domain bridge.
2. **Select:** for any step, the wrapped `selectTools` returns the semantic domain top-K **plus**
   the aux defs (`wait` always in scope); the executor decides whether to use `wait` per its
   description.
3. **Call:** executor issues `wait({ seconds: N })` → composed bridge sees `wait` is aux-owned →
   `aux.callTool('wait', { seconds: N }, { signal })`.
4. **Wait:** `cancelableDelay(min(N, maxSeconds) * 1000, signal)` → returns `"Waited <clamped>s"`.

### Duration ceiling

`min(requested, maxSeconds)` (tool config) AND bounded above by `perStepTimeoutMs`: if the
remaining step budget is less than the wait, the step-timeout aborts the delay → `control-failure
('step-timeout') → replan` (already shipped in #224). The tool description states the max so the
LLM asks for sane values.

### AbortSignal (composition with #224)

The wait's delay listens to the SAME `options.signal` the controller threads into `callMcp`
(`AbortSignal.any([caller, budget.signal])`). Step-timeout / caller-cancel therefore cancels the
wait immediately, and — because `cancelableDelay` **rejects** on abort rather than swallowing —
the controller's existing abort discriminator (`budget.signal.aborted → step-timeout`) fires
unchanged. Zero new cancellation machinery.

## 5. Error handling

- Invalid args (`seconds` not a number / negative) → tool-level `McpError` returned as text to
  the LLM; never escalated.
- Unknown auxiliary tool name → tool-level `McpError` (not thrown as unavailable).
- Abort during wait → `cancelableDelay` rejects with the abort; propagates through `callMcp` to
  the controller catch, where `budget.signal.aborted` maps it to `step-timeout` → replan.
- Clamp to `maxSeconds` → silent clamp; result text notes the cap.
- Name collision (an auxiliary name equal to a domain tool name) → **fail-loud at build**
  (`assertNoAuxCollision`, §3.4) throws a config error so the consumer renames; the run never
  starts with a silently-shadowed domain tool.

## 6. Testing (node:test, RED-first)

- `makeWaitTool` unit: `listTools` returns the def; `callTool('wait', { seconds: 1 })` waits ~1s
  and returns `"Waited 1s"`; a **pre-aborted** signal → rejects immediately (honors signal);
  `seconds` above `maxSeconds` → clamps and the message notes the cap; invalid `seconds` →
  tool-level error, not thrown.
- `composeAuxiliaryBridge` unit: an aux-owned name routes to `aux.callTool` (domain bridge NOT
  called, classifier NOT run); a non-aux name delegates to the domain bridge unchanged; an
  aborted aux call propagates the rejection (not swallowed).
- `composeAuxiliarySelect` unit: the wrapped `selectTools` returns domain results **plus** the
  aux defs (deduped by name); with a domain `selectTools` returning `[]` (MCP-less) the result is
  exactly the aux defs.
- `assertNoAuxCollision` unit (collision gate, async): a fake `toolsRag` whose `lookup('wait')`
  returns a tool → the awaited gate **throws** the clear config error; a `lookup` returning
  `undefined` for every aux name (incl. the `EMPTY_TOOLS_RAG` no-domain case) → no throw; an `aux`
  whose `listTools()` returns `!ok` → the gate throws surfacing that error (not silently skipped).
- DI-threading unit (mirrors the `stepExecutionControl` DI test): `new SmartServer(cfg,
  { auxiliaryMcpTools: custom })` → the resolved `IPipelineContext.auxiliaryMcpTools === custom`;
  and at pipeline build the consumer's `custom` provider **overrides** the default `wait` (the
  default `makeWaitTool` is NOT used when `ctx.auxiliaryMcpTools` is present).
- Integration: an MCP-less controller pipeline still selects and calls `wait`; an auxiliary-tool
  error never triggers the fail-loud escalate path.

## 7. Scope (YAGNI)

**IN (v1):** `IAuxiliaryMcpTools`; `DefaultAuxiliaryMcpTools`; `makeWaitTool` + `cancelableDelay`;
`composeAuxiliaryBridge` + `composeAuxiliarySelect`; `ctx.auxiliaryMcpTools` /
`BuildAgentDeps.auxiliaryMcpTools` DI slot; controller contributes the default `wait` at `build()`.

**OUT (deferred / separate):** RAG-as-tools (separate seam, entirely out); any auxiliary tool
other than `wait`; the consumer guidance skill (consumer repo); rollout to non-controller
pipelines beyond the seam being available; a dedicated `llm-agent-aux-tools` package.

## 8. Architecture-principle check

1. **Build ON components** — reuses `IMcpClient`-shaped `listTools`/`callTool`, the existing
   `buildMcpBridge` and `selectTools` (both wrapped, not modified), and the #224 signal
   plumbing. No bespoke glue in the app.
2. **App is the example** — the controller composing the default `wait` at `build()` demonstrates
   consuming the seam.
3. **Interfaces** — consumers depend on `IAuxiliaryMcpTools`, not a concrete class.
4. **Many small interfaces (ISP)** — a NEW focused `IAuxiliaryMcpTools`, narrower than
   `IMcpClient` (no `healthCheck`); RAG deliberately kept in its own interface.
5. **Variation points → strategies** — the whole provider is consumer-swappable via
   `ctx.auxiliaryMcpTools`.
6. **Control file size** — interface in `llm-agent`; impl in a new `llm-agent-mcp/src/auxiliary/`;
   composition logic in a new `compose-auxiliary.ts`. `smart-server.ts` gets only the minimal
   additive DI field + `buildServerCtx` spread (the established `stepExecutionControl` idiom, ~3-5
   lines, no logic/glue); the controller handler is untouched. The monolith decomposition remains
   a separate tracked roadmap item, unaffected.
7. **Don't break components** — all additions are additive/optional; no-injection + no-`wait`
   path is byte-identical to today.
