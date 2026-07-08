# MCP Timeout Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task ends in exactly one commit; run the pinning tests and the SCOPED lint gate before committing.

**Goal:** Stop the agent from imposing its own timeout on MCP tool calls — MCP self-governs its timeouts by default; the only (opt-in) influence is request headers, conveyed either by the existing static `mcp.headers` pass-through or by a consumer-owned strategy.

**Architecture:** Timeouts are an ownership boundary. The agent already cancels an MCP call via the request's `AbortSignal` at the adapter level (`McpClientAdapter.callTool` wraps the call in `withAbort(options.signal)`). On top of that, the MCP SDK applies its OWN built-in ~60s per-request timeout (because `MCPClientWrapper.callTool` passes no `RequestOptions`), AND the HTTP transport sets a second `AbortSignal.timeout(...)` on `requestInit`. Those two are the redundant "stack" that cut off a slow-but-working MCP call (`-32001` → silent `(no response)` on heavy reviews). This plan removes BOTH imposed cutoffs so the MCP server governs its own timeout, repurposes the now-unused `timeout` config as a connect-only bound, and adds a focused, swappable `IMcpRequestHeadersStrategy` (default no-op) threaded through the ONE config both construction paths share, so a programmatic consumer can convey a "willing to wait" header — the sanctioned cross-isolation influence.

**Tech Stack:** TypeScript (ESM `.js` imports), `node:test` + `tsx`, Biome. Packages: `@mcp-abap-adt/llm-agent` (the new `I*` interface + the `McpConnectionConfig` field), `@mcp-abap-adt/llm-agent-mcp` (`MCPClientWrapper`, factory, no-op strategy), `@mcp-abap-adt/llm-agent-libs` (builder DI seam), `@mcp-abap-adt/llm-agent-server-libs` (the direct server MCP path). SDK: `@modelcontextprotocol/sdk ^1.28.0`.

## Global Constraints

- **Timeout ownership (the binding principle):** the agent times out ONLY what it owns (LLM / our operations). It MUST NOT impose its own *request* timeout on an MCP tool call. Checking a request timeout at BOTH the MCP-call level AND the agent level is the forbidden stack. Default behaviour: **MCP self-governs** — we impose no client-side request cutoff on the tool call. (A short CONNECT-establish bound is a different thing and may remain — see the `timeout` semantics below.)
- **"Effective unbounded", stated honestly.** The MCP SDK's `callTool` requires a numeric per-request `timeout` and defaults it to ~60s; there is no documented "disable". So "no client-imposed timeout" is implemented as an **effectively-unbounded** value (24h) plus `resetTimeoutOnProgress`. Task 1 MUST first check whether the installed SDK (`^1.28.0`) supports a true disable (`0`, `undefined`, `Infinity`, or `maxTotalTimeout` semantics); if it does, use that and reword; otherwise use the large value and label it "effectively unbounded (SDK requires a number)".
- **Keep the agent's cancellation.** The existing `withAbort(options.signal)` in `McpClientAdapter.callTool` is cancellation propagation (abort the tool call when the whole request is aborted) — NOT a timeout we invented. Leave it untouched.
- **Influence is opt-in.** For the YAML/server path, a wait hint is a STATIC entry in the existing `mcp.headers` (already flows to the wrapper on both paths) — no new code needed there. A programmatic/dynamic wait hint uses the new swappable `IMcpRequestHeadersStrategy` (ISP — a new focused interface; default no-op → contributes nothing). The strategy is threaded through `McpConnectionConfig.requestHeadersStrategy` (code-only; never parsed from YAML), which BOTH the builder factory path (`createDefaultMcpClient`) and the direct server path (`connectMcpClientsFromConfig`) copy into the wrapper.
- **SDK version:** `@modelcontextprotocol/sdk ^1.28.0`. The implementer MUST verify `Client.callTool(params, resultSchema?, options?: RequestOptions)` and `RequestOptions` (`timeout`, `resetTimeoutOnProgress`, `maxTotalTimeout`) against the installed version (`node_modules/@modelcontextprotocol/sdk`) before finalizing, and adapt to the actual names/positions.
- ESM `.js` imports, TS strict, Biome, `noUnusedLocals: true`, interfaces `I`-prefixed, additive/backward-compatible (don't break `McpConnectionConfig`/`MCPClientConfig` consumers).
- **SCOPED lint gate per task:** `npx @biomejs/biome check --write <changed files>` → `npm run lint:check` **exit 0**. NOT the global `npm run format`.
- **Commit ONLY this task's files:** `git status --short`, `git add` explicit paths (NOT `-A`/`.`).
- **Release:** after all tasks, bump to **20.3.0** (the `v20.2.0` tag is pushed but NOT published — do NOT touch it). npm publish stays user-only (yubikey).

---

## File Structure

- `packages/llm-agent-mcp/src/client.ts` — **(Task 1, 2, 3)** `MCPClientWrapper`: (1) pass `RequestOptions` to the SDK `callTool` so the SDK's ~60s does NOT fire; (2) remove the transport `requestInit.signal` per-request cutoff and repurpose `MCPClientConfig.timeout` as a connect-only bound; (3) read `requestHeadersStrategy` and merge its headers at connect.
- `packages/llm-agent/src/interfaces/mcp-request-headers-strategy.ts` — **(Task 3, create)** `IMcpRequestHeadersStrategy` (+ barrel export).
- `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts` — **(Task 3, modify)** add `requestHeadersStrategy?: IMcpRequestHeadersStrategy` to `McpConnectionConfig` (code-only field).
- `packages/llm-agent-mcp/src/no-op-request-headers-strategy.ts` — **(Task 3, create)** `NoopMcpRequestHeadersStrategy`.
- `packages/llm-agent-mcp/src/factory.ts` — **(Task 3, modify)** `createDefaultMcpClient` copies `config.requestHeadersStrategy` into the wrapper.
- `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — **(Task 3, modify ~543)** the direct server path copies `cfg.requestHeadersStrategy` into the wrapper (undefined from YAML → no-op).
- `packages/llm-agent-libs/src/builder.ts` — **(Task 4)** `withMcpRequestHeadersStrategy(...)` attaches the strategy to the `McpConnectionConfig`s it builds.
- `docs/EXAMPLES.md` + `packages/llm-agent-mcp/README.md` — **(Task 5)**.
- Tests: `packages/llm-agent-mcp/src/__tests__/*.test.ts` (Tasks 1-3), a builder test (Task 4). **Task 6** = live acceptance (no commit).

---

### Task 1 — MCP tool call no longer imposes the SDK's per-request timeout

The primary fix. `MCPClientWrapper.callTool` calls the SDK `client.callTool({name, arguments})` with NO third `RequestOptions`, so the SDK applies its `DEFAULT_REQUEST_TIMEOUT_MSEC` (~60s). Make MCP self-govern.

**Files:** modify `packages/llm-agent-mcp/src/client.ts` (`callTool` `performCall`, ~line 406); test `packages/llm-agent-mcp/src/__tests__/mcp-client-request-timeout.test.ts` (create).

**Steps:**

- [ ] **Verify the SDK first.** `find node_modules/@modelcontextprotocol/sdk -name '*.d.ts' | xargs grep -ln callTool` then read the `callTool` signature + the `RequestOptions` type (`Protocol.request`). Confirm the 3rd arg is `resultSchema?` and options is 3rd/4th, and confirm `timeout` + `resetTimeoutOnProgress` exist. Check for a true-disable (`timeout: 0`/`undefined`/`maxTotalTimeout`). Record findings in the report; adapt the code below to the real signature.
- [ ] **Failing test first** in `mcp-client-request-timeout.test.ts`. Build an `MCPClientWrapper` and drive the non-embedded `callTool` path with a spy for the underlying SDK client: `wrapper['client'] = { callTool: (params: unknown, schema: unknown, options: unknown) => { captured = { params, schema, options }; return Promise.resolve({ content: [] }); } } as unknown as never; wrapper['detectedTransport'] = 'stream-http';` (READ `client.ts` `callTool` ~358-430 to confirm the exact private field names + the embedded branch guard). Then `await wrapper.callTool({ id: '1', name: 't', arguments: {} })`. Assert:
  - `captured.options` is defined (a 3rd/4th RequestOptions arg is passed);
  - `captured.options.timeout >= 86_400_000` (≥ 24h — effectively unbounded), OR the true-disable value found in step 1;
  - `captured.options.resetTimeoutOnProgress === true`.
- [ ] Run → FAILS (today no options arg).
- [ ] **Implement.** Add near the top of `client.ts` (after imports):
  ```ts
  /** MCP self-governs its own request timeout. The SDK forces a numeric
   *  per-request timeout (~60s default) with no documented disable, so we pass
   *  an effectively-unbounded value (24h) + resetTimeoutOnProgress. Cancellation
   *  still comes from the agent's AbortSignal via McpClientAdapter.callTool. */
  const MCP_NO_CLIENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
  ```
  and change the SDK call in `performCall`:
  ```ts
  const response = await this.client?.callTool(
    { name: toolCall.name, arguments: toolCall.arguments },
    undefined,
    { timeout: MCP_NO_CLIENT_TIMEOUT_MS, resetTimeoutOnProgress: true },
  );
  ```
  (Adjust arg position to the verified signature.)
- [ ] Run tests → GREEN. `npm run build`. Existing `llm-agent-mcp` suites still green. SCOPED lint gate. Commit: `fix(mcp): MCP self-governs its request timeout — do not impose the SDK's 60s on tool calls`.

---

### Task 2 — remove the transport per-request cutoff; repurpose `timeout` as connect-only

`client.ts` ~263 sets `signal: AbortSignal.timeout(this.config.timeout || 30000)` on the transport `requestInit` — a one-shot wall-clock abort created at connect that can cut off a long tool call (a second stacked timeout). Remove it from per-request use; if a connect bound is wanted, apply `timeout` ONLY to `connect()`. Redefine the public `MCPClientConfig.timeout` accordingly so it does not become dead.

**Files:** modify `packages/llm-agent-mcp/src/client.ts` (~115 doc + ~254-278 connect); extend `mcp-client-request-timeout.test.ts`.

**Steps:**

- [ ] **Failing test first.** Factor a small pure helper `export function buildHttpRequestInit(config: Pick<MCPClientConfig,'headers'|'requestHeadersStrategy'>): RequestInit` that returns the `{ headers }` object used for the transport (NO per-request `signal`). Test: `buildHttpRequestInit({ headers: { A: '1' } }).signal === undefined` AND its `headers` include `Accept` + `A`. (This helper is reused by Task 3 for the strategy merge.)
- [ ] Run → FAILS (helper doesn't exist / today the connect sets a `signal`).
- [ ] **Implement.**
  - Extract `buildHttpRequestInit(...)` and use it at the transport construction (replace the inline `requestInit` object). It sets `headers` only — NO `signal`.
  - If keeping a connect-establish bound: wrap ONLY the connect, e.g. `await withAbort(this.client.connect(httpTransport), AbortSignal.timeout(this.config.timeout ?? 30000), () => new Error('MCP connect timed out'))` (import `withAbort`; confirm its signature in the codebase). If simpler and acceptable, drop the connect bound entirely — but do NOT leave a per-request signal.
  - Update the `MCPClientConfig.timeout` doc comment (~115) to: `/** Connect-establish timeout in ms (default 30000). NOT a per-request timeout — MCP self-governs request timeouts. */`
- [ ] Run tests → GREEN. `npm run build`. Existing suites green. SCOPED lint gate. Commit: `fix(mcp): drop the transport per-request signal; timeout is connect-only (MCP governs requests)`.

---

### Task 3 — `IMcpRequestHeadersStrategy` (no-op default) threaded through both construction paths

**Files:** create `packages/llm-agent/src/interfaces/mcp-request-headers-strategy.ts` + barrel export; modify `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts` (add field); create `packages/llm-agent-mcp/src/no-op-request-headers-strategy.ts`; modify `packages/llm-agent-mcp/src/client.ts` (config field + merge via `buildHttpRequestInit`), `packages/llm-agent-mcp/src/factory.ts`, `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (~543); test `packages/llm-agent-mcp/src/__tests__/mcp-request-headers-strategy.test.ts`.

**Interfaces (Produces):**
```ts
// packages/llm-agent/src/interfaces/mcp-request-headers-strategy.ts
/** Consumer-owned strategy contributing HTTP headers to MCP requests. The engine
 *  imposes NO MCP request timeout; a consumer may use this to convey a "willing to
 *  wait longer" hint (or anything else) to the server. Default = no-op. */
export interface IMcpRequestHeadersStrategy {
  /** Headers merged into the MCP connection requestInit at connect. */
  headers(): Record<string, string>;
}
```
And add to `McpConnectionConfig` (mcp-connection-strategy.ts): `requestHeadersStrategy?: IMcpRequestHeadersStrategy;` (code-only; import the interface type).

**Steps:**

- [ ] **Create the interface** + add `export * from './mcp-request-headers-strategy.js';` to `packages/llm-agent/src/interfaces/index.ts` (match barrel style). Add the optional field to `McpConnectionConfig`. `npm run build` to confirm exports + no break.
- [ ] **Failing test** (`no-op` case) in `mcp-request-headers-strategy.test.ts`: `new NoopMcpRequestHeadersStrategy().headers()` deep-equals `{}`.
- [ ] **Implement** `no-op-request-headers-strategy.ts`:
  ```ts
  import type { IMcpRequestHeadersStrategy } from '@mcp-abap-adt/llm-agent';
  /** Default: contribute nothing — MCP self-governs its timeout. */
  export class NoopMcpRequestHeadersStrategy implements IMcpRequestHeadersStrategy {
    headers(): Record<string, string> {
      return {};
    }
  }
  ```
- [ ] **Failing test** (merge) in the same test: call `buildHttpRequestInit({ headers: { A: '1' }, requestHeadersStrategy: { headers: () => ({ 'X-Wait': '600' }) } })` and assert the returned `headers` include `Accept`, `A: '1'`, AND `X-Wait: '600'`; and with no strategy the headers are `{ Accept, A: '1' }` (unchanged).
- [ ] Run → FAILS.
- [ ] **Implement.**
  - `client.ts`: add `requestHeadersStrategy?: IMcpRequestHeadersStrategy;` to `MCPClientConfig` (doc comment). In `buildHttpRequestInit`, merge `...(config.requestHeadersStrategy?.headers() ?? {})` LAST into the headers (after `...config.headers`). Default the field to `new NoopMcpRequestHeadersStrategy()` in the constructor OR rely on the `?.` (choose one; if defaulting in ctor, the merge uses it — keep it simple, `?.` at merge is enough).
  - `factory.ts` `createDefaultMcpClient` (http branch): add `...(config.requestHeadersStrategy ? { requestHeadersStrategy: config.requestHeadersStrategy } : {})` to the `new MCPClientWrapper({...})` options.
  - `smart-server.ts` (~543, http branch): add `requestHeadersStrategy: cfg.requestHeadersStrategy` to the `new MCPClientWrapper({...})` (undefined from YAML → no-op).
- [ ] Run tests → GREEN. `npm run build` (all packages, cross-package types). SCOPED lint gate. Commit: `feat(mcp): IMcpRequestHeadersStrategy (no-op default) threaded through factory + server paths`.

---

### Task 4 — builder DI seam `withMcpRequestHeadersStrategy`

**Files:** modify `packages/llm-agent-libs/src/builder.ts` (fluent setter + attach to the `McpConnectionConfig`s built near `makeConnectionStrategy`); test `packages/llm-agent-libs/src/__tests__/*` (focused builder test).

**Steps:**

- [ ] **Read** `builder.ts` around `withMcpConnectionStrategy` and where YAML `mcp:` becomes `McpConnectionConfig[]` handed to `makeConnectionStrategy(...)`. Confirm the exact array so the strategy can be attached to each entry's `requestHeadersStrategy`.
- [ ] **Failing test first.** Mirror an existing builder MCP test: call `builder.withMcpRequestHeadersStrategy(strategy)` (+ minimal `mcp:` config) and assert each resolved `McpConnectionConfig` carries `requestHeadersStrategy === strategy`. Without calling it, assert `requestHeadersStrategy` is undefined. (Use the same seam existing tests use to read the resolved MCP configs; if none, assert via a spy on `makeConnectionStrategy`'s input.)
- [ ] Run → FAILS.
- [ ] **Implement.** Add `private _mcpRequestHeadersStrategy?: IMcpRequestHeadersStrategy;` + setter:
  ```ts
  withMcpRequestHeadersStrategy(strategy: IMcpRequestHeadersStrategy): this {
    this._mcpRequestHeadersStrategy = strategy;
    return this;
  }
  ```
  and, where the `McpConnectionConfig[]` is assembled, set `requestHeadersStrategy: this._mcpRequestHeadersStrategy` on each entry (only when defined). Import the type from `@mcp-abap-adt/llm-agent`.
- [ ] Run tests → GREEN. `npm run build`. SCOPED lint gate. Commit: `feat(builder): withMcpRequestHeadersStrategy DI seam (default no-op)`.

---

### Task 5 — Docs

**Files:** modify `docs/EXAMPLES.md` (the `mcp:` section) and `packages/llm-agent-mcp/README.md`.

**Steps:**

- [ ] Grep for the current MCP timeout/headers wording (`rg -n "timeout|headers|mcp:" docs/EXAMPLES.md packages/llm-agent-mcp/README.md`). Add a short accurate note: the engine imposes NO client-side request timeout on MCP tool calls — the MCP server governs its own; `MCPClientConfig.timeout` is a connect-establish bound only. To convey a "willing to wait" hint: YAML/server users add a header under the existing `mcp.headers`; programmatic users can supply a custom `IMcpRequestHeadersStrategy` (default no-op) via `withMcpRequestHeadersStrategy`. State the capability; invent no new YAML keys. NOTE the exact file is `packages/llm-agent-mcp/README.md` (NOT `src/README.md`).
- [ ] `npm run lint:check` exit 0. Commit: `docs(mcp): MCP self-governs request timeouts; timeout is connect-only; wait hints via headers/strategy`.

---

### Task 6 — Live acceptance (the reporter's real prompt, correct system)

No code change — the end-to-end proof.

**Steps:**

- [ ] Build. Start `node packages/llm-agent-server/dist/smart-agent/cli.js --config .run/skills-review-github.yaml --env-path .env`. Confirm `/health` → `mcp ok:true`, `ready:true`.
- [ ] Send the controller review for an object that EXISTS on the :3001 system — **`ZDAZ_R_DELAYED_UPDATE`** (NOT `zdms_upload_files`, which is on a different system): `POST /v1/chat/completions` `{"model":"controller","stream":false,"messages":[{"role":"user","content":"Review ABAP program ZDAZ_R_DELAYED_UPDATE, check security, performance, CleanCore, maintainability"}]}`.
- [ ] Assert: the delivered answer is a REAL, non-empty review that references the program — NOT `(no response)`; and the server output shows the tool loop completing with NO `MCP error -32001: Request timed out` cutting it off. Record toolCount/tool_calls + the answer head.
- [ ] (Optional) Re-run with a wait header (either an `mcp.headers` entry in the YAML, or a `withMcpRequestHeadersStrategy` in a tiny composition) to exercise the opt-in influence path.
- [ ] Stop the server. No commit; record results in the task report.

---

## Notes

- **Fail-loud gap (deferred, tracked):** once the request timeout is not imposed, the heavy-review `(no response)` disappears because the run completes. A GENUINE server-side timeout should still surface loud (an explicit error, not `(no response)`), per the #201-205 fail-loud lineage — a SEPARATE concern, not in this plan. If Task 6 still shows a silent `(no response)` on a real timeout, open a follow-up.
- **Scope of the strategy:** the strategy is threaded to BOTH construction paths via `McpConnectionConfig.requestHeadersStrategy`, but only the CODE-composition (builder) surface exposes a setter today; the direct-server/YAML surface conveys wait hints via static `mcp.headers` (a server-composition seam for a code strategy is out of scope — note it if a consumer asks).
- No agent-level LLM timeouts change. The agent's `withAbort(options.signal)` cancellation stays.
