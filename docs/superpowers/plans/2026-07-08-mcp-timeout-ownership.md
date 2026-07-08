# MCP Timeout Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task ends in exactly one commit; run the pinning tests and the SCOPED lint gate before committing.

**Goal:** Stop the agent from imposing its own timeout on MCP tool calls — MCP self-governs its timeouts by default; the only (opt-in) influence is request headers conveyed through a consumer-owned strategy.

**Architecture:** Timeouts are an ownership boundary. The agent already cancels an MCP call via the request's `AbortSignal` at the adapter level (`McpClientAdapter.callTool` wraps the call in `withAbort(options.signal)`). On top of that, the MCP SDK applies its OWN built-in ~60s per-request timeout (because `MCPClientWrapper.callTool` passes no `RequestOptions`), AND the HTTP transport sets a second `AbortSignal.timeout(...)` on `requestInit`. Those two are the redundant "stack" that cut off a slow-but-working MCP call (`-32001` → silent `(no response)` on heavy reviews). This plan removes BOTH imposed cutoffs so the MCP server governs its own timeout, and adds a focused, swappable `IMcpRequestHeadersStrategy` (default no-op) so a consumer can tell the server "I'll wait longer" via headers — the ONLY sanctioned cross-isolation influence.

**Tech Stack:** TypeScript (ESM `.js` imports), `node:test` + `tsx`, Biome. Packages: `@mcp-abap-adt/llm-agent` (the new `I*` interface), `@mcp-abap-adt/llm-agent-mcp` (`MCPClientWrapper` + no-op strategy), `@mcp-abap-adt/llm-agent-libs` (builder DI seam). SDK: `@modelcontextprotocol/sdk ^1.28.0`.

## Global Constraints

- **Timeout ownership (the binding principle):** the agent times out ONLY what it owns (LLM / our operations). It MUST NOT impose its own timeout on an MCP tool call. Checking a timeout at BOTH the MCP-call level AND the agent level is the forbidden stack. Default behaviour: **MCP self-governs** — we impose no client-side cutoff on the tool call.
- **Keep the agent's cancellation.** The existing `withAbort(options.signal)` in `McpClientAdapter.callTool` is cancellation propagation (abort the tool call when the whole request is aborted) — NOT a timeout we invented. Leave it. Only the SDK's implicit per-request timeout and the transport's `AbortSignal.timeout` are removed.
- **Influence is opt-in and strategy-gated.** Conveying a "willing to wait" hint to the server crosses the isolation boundary, so it is done ONLY via a swappable, consumer-owned `IMcpRequestHeadersStrategy` (ISP — a new focused interface, not a bolt-on). Default strategy = no-op (contributes no headers → MCP decides). The existing `mcp.headers` YAML pass-through stays.
- **SDK version:** `@modelcontextprotocol/sdk ^1.28.0`. The implementer MUST verify the exact `Client.callTool(params, resultSchema?, options?: RequestOptions)` signature and `RequestOptions` fields (`timeout`, `resetTimeoutOnProgress`, `maxTotalTimeout`) against the installed version before finalizing (`node_modules/@modelcontextprotocol/sdk`), and adapt if the field names differ.
- ESM `.js` imports, TS strict, Biome, `noUnusedLocals: true`, interfaces `I`-prefixed.
- **SCOPED lint gate per task:** `npx @biomejs/biome check --write <changed files>` → `npm run lint:check` requiring **exit 0**. NOT the global `npm run format`.
- **Commit ONLY this task's files:** `git status --short`, `git add` explicit paths (NOT `-A`/`.`).
- **Release:** after all tasks, bump to **20.3.0** (the `v20.2.0` tag is pushed but NOT published — do NOT touch it). npm publish stays user-only (yubikey).

---

## File Structure

- `packages/llm-agent-mcp/src/client.ts` — **(Task 1, 2)** `MCPClientWrapper`: (1) pass `RequestOptions` to the SDK `callTool` so the SDK's ~60s does NOT fire (MCP self-governs); (2) the transport `requestInit.signal` (line ~263) must not impose a per-request MCP timeout — scope it to connect only (or remove). Also consumes the header strategy (Task 3).
- `packages/llm-agent/src/interfaces/mcp-request-headers-strategy.ts` — **(Task 3, create)** the new focused `IMcpRequestHeadersStrategy` interface (+ export from the interfaces barrel).
- `packages/llm-agent-mcp/src/no-op-request-headers-strategy.ts` — **(Task 3, create)** `NoopMcpRequestHeadersStrategy` (default; returns `{}`), and `MCPClientConfig.requestHeadersStrategy?` wiring in `client.ts`.
- `packages/llm-agent-libs/src/builder.ts` — **(Task 4)** DI seam `withMcpRequestHeadersStrategy(...)` mirroring `withMcpConnectionStrategy`, defaulting to the no-op.
- `docs/EXAMPLES.md` (+ `src/mcp/README.md`) — **(Task 5)** document that MCP self-governs timeouts and the header-strategy influence.
- Tests: `packages/llm-agent-mcp/src/__tests__/*.test.ts` (Tasks 1-3), a builder test (Task 4). **Task 6** = live acceptance (no commit).

---

### Task 1 — MCP tool call no longer imposes the SDK's per-request timeout

The primary fix. `MCPClientWrapper.callTool` calls the SDK `client.callTool({name, arguments})` with NO third `RequestOptions` argument, so the SDK applies its `DEFAULT_REQUEST_TIMEOUT_MSEC` (~60s). Pass a `RequestOptions` that does NOT impose our cutoff, so the MCP server governs.

**Files:** modify `packages/llm-agent-mcp/src/client.ts` (the `callTool` `performCall`, ~line 406); test `packages/llm-agent-mcp/src/__tests__/mcp-client-request-timeout.test.ts` (create).

**Steps:**

- [ ] **Verify the SDK signature first.** Read the installed SDK: confirm `Client.callTool` accepts a 3rd `options?: RequestOptions` and that `RequestOptions` has `timeout?: number` and `resetTimeoutOnProgress?: boolean` (`find node_modules/@modelcontextprotocol/sdk -name '*.d.ts' | xargs grep -l callTool`; read the `Protocol.request` / `RequestOptions` type). If the field names differ in 1.28.0, use the actual names and note it in the report.
- [ ] **Failing test first** in `mcp-client-request-timeout.test.ts`. Construct an `MCPClientWrapper` in a mode where you can spy on the underlying `client.callTool` args. The cleanest seam: set `this.client` to a fake via the existing test hooks, OR (if none) spy by assigning `wrapper['client'] = { callTool: (params, schema, options) => { captured = { params, options }; return Promise.resolve({ content: [] }); } } as any` and set `wrapper['detectedTransport']` to a non-embedded value so `performCall` runs the `this.client.callTool` path. (READ `client.ts` `callTool` ~358-430 to see the exact private fields and the embedded/non-embedded branch.) Assert:
  - `client.callTool` is called with a THIRD argument (RequestOptions) — i.e. `captured.options` is defined.
  - `captured.options.timeout` is a LARGE value (no ~60s cutoff): assert `captured.options.timeout >= 86_400_000` (≥ 24h — an effective "no client cap"), OR that `resetTimeoutOnProgress === true` AND the timeout is not the 60s default. Pick the concrete assertion matching the implementation below.
  - `captured.options.resetTimeoutOnProgress === true`.
- [ ] Run → FAILS (today no 3rd arg is passed).
- [ ] **Implement.** In `client.ts`, add a module-level constant and pass options to the SDK call. Replace:
  ```ts
  const response = await this.client?.callTool({
    name: toolCall.name,
    arguments: toolCall.arguments,
  });
  ```
  with:
  ```ts
  // MCP self-governs its own timeout. We do NOT impose a client-side cutoff on
  // the tool call (that would stack on the agent's own AbortSignal, already
  // applied by McpClientAdapter.callTool). The SDK forces a per-request timeout
  // with a ~60s default, so we pass an effectively-unbounded one plus
  // resetTimeoutOnProgress; the server (or the agent's abort) decides when to stop.
  const response = await this.client?.callTool(
    { name: toolCall.name, arguments: toolCall.arguments },
    undefined,
    { timeout: MCP_NO_CLIENT_TIMEOUT_MS, resetTimeoutOnProgress: true },
  );
  ```
  and add near the top of the file (after imports):
  ```ts
  /** Effective "no client-imposed timeout" for MCP tool calls: MCP self-governs,
   *  and the agent's AbortSignal (McpClientAdapter) provides cancellation. 24h. */
  const MCP_NO_CLIENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
  ```
  (If the SDK's 3rd arg is not `resultSchema` but `options` directly in 1.28.0, drop the `undefined` and pass `{ timeout, resetTimeoutOnProgress }` in the correct position — verify against the signature from step 1.)
- [ ] Run tests → GREEN. `npm run build`. Run the existing MCP suites (`packages/llm-agent-mcp/src/__tests__/*.test.ts`) → still green. SCOPED lint gate. Commit: `fix(mcp): let MCP self-govern its request timeout — do not impose the SDK's 60s on tool calls`.

---

### Task 2 — transport `requestInit.signal` must not impose a per-request MCP timeout

`client.ts` ~line 263 sets `signal: AbortSignal.timeout(this.config.timeout || 30000)` on the `StreamableHTTPClientTransport` `requestInit`. A one-shot `AbortSignal.timeout` created once at connect time imposes a wall-clock cutoff on the transport's requests — a second stacked MCP timeout. It must not cut off a long-running tool call.

**Files:** modify `packages/llm-agent-mcp/src/client.ts` (~254-266); extend `mcp-client-request-timeout.test.ts`.

**Steps:**

- [ ] **Read** the connect region (~252-278) and confirm how `requestInit` is used by `StreamableHTTPClientTransport` (per-request vs one-shot) — check the SDK transport source if needed. The goal: the connection may have a *connect/establish* bound, but individual tool-call requests must NOT be aborted by a fixed post-connect timer.
- [ ] **Failing test first.** In a test, construct the wrapper for an HTTP URL and capture the `requestInit` passed to `StreamableHTTPClientTransport` (spy the constructor, or factor a small pure helper `buildRequestInit(config, strategyHeaders)` that returns the `requestInit` object and unit-test THAT). Assert `requestInit.signal` is NOT a fixed `AbortSignal.timeout(...)` that would fire during a long tool call — i.e. the helper does not set a post-connect wall-clock abort on request `signal` (assert `requestInit.signal === undefined`, or that the timeout is only applied to the initial `connect()` call, per the chosen implementation).
- [ ] Run → FAILS (today `signal: AbortSignal.timeout(config.timeout||30000)` is present).
- [ ] **Implement.** Remove the perpetual `signal` from the transport `requestInit` so per-request MCP calls are not cut off. If a *connect-establish* timeout is still wanted, apply it ONLY around the `await this.client.connect(httpTransport)` call (e.g. `withAbort(this.client.connect(httpTransport), AbortSignal.timeout(this.config.timeout ?? 30000), ...)`), NOT on every request. Prefer the minimal change: drop the `signal` line from `requestInit`; keep `headers`. Extract a small `buildRequestInit(...)` pure helper if it makes the test cleaner.
- [ ] Run tests → GREEN. `npm run build`. Existing MCP suites still green. SCOPED lint gate. Commit: `fix(mcp): drop the transport requestInit wall-clock signal so it cannot cut off a running tool call`.

---

### Task 3 — `IMcpRequestHeadersStrategy` (focused, consumer-owned, default no-op)

The ONLY sanctioned way to influence the server's timeout: a swappable strategy that contributes request headers (e.g. a "willing to wait longer" header). Default injects nothing.

**Files:** create `packages/llm-agent/src/interfaces/mcp-request-headers-strategy.ts` + export from the interfaces barrel (`packages/llm-agent/src/interfaces/index.ts`); create `packages/llm-agent-mcp/src/no-op-request-headers-strategy.ts`; modify `packages/llm-agent-mcp/src/client.ts` (config field + merge headers at connect, ~259-262); test `packages/llm-agent-mcp/src/__tests__/mcp-request-headers-strategy.test.ts`.

**Interfaces (Produces):**
```ts
// packages/llm-agent/src/interfaces/mcp-request-headers-strategy.ts
/** Consumer-owned strategy that contributes HTTP headers to MCP requests.
 *  The engine imposes NO MCP timeout; a consumer may use this to tell the
 *  server it is willing to wait longer (or anything else). Default = no-op. */
export interface IMcpRequestHeadersStrategy {
  /** Headers to merge into the MCP connection requestInit. Called at connect. */
  headers(): Record<string, string>;
}
```

**Steps:**

- [ ] **Create the interface** file above and add `export * from './mcp-request-headers-strategy.js';` (match the barrel's existing style) to `packages/llm-agent/src/interfaces/index.ts`. `npm run build` to confirm it exports.
- [ ] **Failing test first** in `no-op-request-headers-strategy.test.ts` (in llm-agent-mcp): `new NoopMcpRequestHeadersStrategy().headers()` deep-equals `{}`.
- [ ] **Implement** `packages/llm-agent-mcp/src/no-op-request-headers-strategy.ts`:
  ```ts
  import type { IMcpRequestHeadersStrategy } from '@mcp-abap-adt/llm-agent';
  /** Default strategy: contribute nothing — MCP self-governs its timeout. */
  export class NoopMcpRequestHeadersStrategy implements IMcpRequestHeadersStrategy {
    headers(): Record<string, string> {
      return {};
    }
  }
  ```
- [ ] **Failing test first** for the merge in `mcp-request-headers-strategy.test.ts`: construct an `MCPClientWrapper` with `requestHeadersStrategy: { headers: () => ({ 'X-Wait': '600' }) }` and capture the connection `requestInit.headers` (reuse the `buildRequestInit` helper from Task 2, or spy the transport ctor). Assert the merged headers include BOTH `...config.headers` AND `X-Wait: 600`, and that with no strategy (default no-op) the headers equal `{ Accept, ...config.headers }` (unchanged from today).
- [ ] Run → FAILS.
- [ ] **Implement.** In `client.ts`: add `requestHeadersStrategy?: IMcpRequestHeadersStrategy;` to `MCPClientConfig` (with a doc comment), default it to `new NoopMcpRequestHeadersStrategy()` in the constructor, and merge at the connect header assembly (~259-262):
  ```ts
  headers: {
    Accept: 'application/json, text/event-stream',
    ...this.config.headers,
    ...(this.config.requestHeadersStrategy?.headers() ?? {}),
  },
  ```
  Import `NoopMcpRequestHeadersStrategy` and the `IMcpRequestHeadersStrategy` type.
- [ ] Run tests → GREEN. `npm run build`. SCOPED lint gate. Commit: `feat(mcp): IMcpRequestHeadersStrategy (default no-op) — the only opt-in way to convey a wait hint to the server`.

---

### Task 4 — builder DI seam `withMcpRequestHeadersStrategy`

Let the consumer select the strategy through the builder, mirroring `withMcpConnectionStrategy`; default = no-op.

**Files:** modify `packages/llm-agent-libs/src/builder.ts` (the fluent setter + where MCP client configs are assembled — near `withMcpConnectionStrategy` / `makeConnectionStrategy`); test `packages/llm-agent-libs/src/__tests__/*` (a focused builder test, create if needed).

**Steps:**

- [ ] **Read** `builder.ts` around `withMcpConnectionStrategy` and where the `mcp:` configs are turned into `MCPClientConfig`s (the `makeConnectionStrategy(...)` region). Confirm exactly where an `MCPClientConfig` is built so the strategy can be attached to `requestHeadersStrategy`.
- [ ] **Failing test first.** In a builder test, call `builder.withMcpRequestHeadersStrategy(strategy)` and assert the assembled `MCPClientConfig` carries `requestHeadersStrategy === strategy` (inspect via the same seam existing builder tests use to read resolved MCP configs; mirror the `withMcpConnectionStrategy` test if one exists). Also assert that WITHOUT calling it, the resolved config's `requestHeadersStrategy` is undefined (the wrapper supplies the no-op default) OR is the no-op — match the wiring you choose.
- [ ] Run → FAILS.
- [ ] **Implement.** Add `private _mcpRequestHeadersStrategy?: IMcpRequestHeadersStrategy;` + a fluent setter:
  ```ts
  withMcpRequestHeadersStrategy(strategy: IMcpRequestHeadersStrategy): this {
    this._mcpRequestHeadersStrategy = strategy;
    return this;
  }
  ```
  and attach `requestHeadersStrategy: this._mcpRequestHeadersStrategy` when building each `MCPClientConfig`. Import the interface type from `@mcp-abap-adt/llm-agent`.
- [ ] Run tests → GREEN. `npm run build`. SCOPED lint gate. Commit: `feat(builder): withMcpRequestHeadersStrategy DI seam (default no-op)`.

---

### Task 5 — Docs: MCP self-governs timeouts; influence only via the header strategy

**Files:** modify `docs/EXAMPLES.md` (the `mcp:` section) and `packages/llm-agent-mcp/src/README.md` (MCP transport config).

**Steps:**

- [ ] Grep the docs for the current MCP timeout/`headers` wording (`rg -n "timeout|headers|mcp:" docs/EXAMPLES.md packages/llm-agent-mcp/src/README.md`). Add a short, accurate note: the engine imposes NO client-side timeout on MCP tool calls — the MCP server governs its own timeout; a consumer that needs to convey "willing to wait longer" does so via request headers, either the existing `mcp.headers` pass-through or a custom `IMcpRequestHeadersStrategy` (default no-op). Do NOT invent config keys; state the capability.
- [ ] `npm run lint:check` exit 0 (Biome does not lint `.md`; run to be safe). Commit: `docs(mcp): MCP self-governs request timeouts; convey wait hints via headers/strategy`.

---

### Task 6 — Live acceptance (the reporter's real prompt)

No code change — the end-to-end proof that removing the imposed timeout fixes the observed `(no response)`.

**Steps:**

- [ ] Build (`npm run build`). Start the real config `node packages/llm-agent-server/dist/smart-agent/cli.js --config .run/skills-review-github.yaml --env-path .env` (controller + SAP AI Core + MCP `http://localhost:3001` + GitHub sap-skills). Confirm `/health` → `mcp ok:true`, `ready:true`.
- [ ] Send the controller review for an object that EXISTS on the :3001 system — **`ZDAZ_R_DELAYED_UPDATE`** (NOT `zdms_upload_files`, which lives on a different system): `POST /v1/chat/completions` with `{"model":"controller","stream":false,"messages":[{"role":"user","content":"Review ABAP program ZDAZ_R_DELAYED_UPDATE, check security, performance, CleanCore, maintainability"}]}`.
- [ ] Assert: the delivered answer is a REAL review (non-empty, references the program), NOT `(no response)`; and the server output shows the tool loop completing without an `MCP error -32001: Request timed out` cutting it off. Record toolCount/tool_calls + the answer head.
- [ ] (Optional) Re-run with `builder.withMcpRequestHeadersStrategy(...)` or an `mcp.headers` entry injecting a wait header, to demonstrate the opt-in influence path. Record.
- [ ] Stop the server. No commit (verification only); record results in the task report.

---

## Notes

- **Fail-loud gap (deferred, tracked):** once the timeout is not imposed, the heavy-review `(no response)` disappears because the run completes. A GENUINE server-side timeout should still surface loud (an explicit error, not `(no response)`) per the #201-205 fail-loud lineage — that is a SEPARATE concern, not in this plan. If Task 6 still shows a silent `(no response)` on a real server timeout, open a follow-up rather than expanding scope here.
- No agent-level LLM timeouts change. The agent's `withAbort(options.signal)` cancellation in `McpClientAdapter.callTool` stays — it is cancellation, not an imposed MCP timeout.
