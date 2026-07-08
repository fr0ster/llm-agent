# MCP Timeout Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task ends in exactly one commit; run the pinning tests and the SCOPED lint gate before committing.

**Goal:** Stop the agent from imposing its own timeout on MCP tool calls — MCP self-governs its timeouts by default; the only (opt-in) influence is request headers, conveyed either by the existing static `mcp.headers` pass-through or by a consumer-owned strategy.

**Architecture:** Timeouts are an ownership boundary. The agent already cancels an MCP call via the request's `AbortSignal` at the adapter level (`McpClientAdapter.callTool` wraps the call in `withAbort(options.signal)`). On top of that, the MCP SDK applies its OWN built-in ~60s per-request timeout (because `MCPClientWrapper.callTool` passes no `RequestOptions`), AND the HTTP transport sets a second `AbortSignal.timeout(...)` on `requestInit`. Those two are the redundant "stack" that cut off a slow-but-working MCP call (`-32001` → silent `(no response)` on heavy reviews). This plan removes BOTH imposed cutoffs so the MCP server governs its own timeout, deprecates the now-unused `timeout` config (no longer wired; kept for backward-compat), and adds a focused, swappable `IMcpRequestHeadersStrategy` (default no-op) threaded through the builder→factory path (`McpConnectionConfig` → `createDefaultMcpClient`), so a programmatic consumer can convey a "willing to wait" header — the sanctioned cross-isolation influence. The direct server/YAML path is not extended (YAML can't carry a code strategy); its wait hints use static `mcp.headers`, and it inherits the universal timeout fix because that lives in `MCPClientWrapper`.

**Tech Stack:** TypeScript (ESM `.js` imports), `node:test` + `tsx`, Biome. Packages: `@mcp-abap-adt/llm-agent` (the new `I*` interface + the `McpConnectionConfig` field), `@mcp-abap-adt/llm-agent-mcp` (`MCPClientWrapper`, factory, no-op strategy), `@mcp-abap-adt/llm-agent-libs` (builder DI seam). The direct server/YAML MCP path (`llm-agent-server-libs`) is NOT modified (out of scope — YAML can't carry a code strategy). SDK: `@modelcontextprotocol/sdk ^1.28.0`.

## Global Constraints

- **Timeout ownership (the binding principle):** the agent times out ONLY what it owns (LLM / our operations). It MUST NOT impose its own *request* timeout on an MCP tool call. Checking a request timeout at BOTH the MCP-call level AND the agent level is the forbidden stack. Default behaviour: **MCP self-governs** — we impose no client-side request cutoff on the tool call. (A short CONNECT-establish bound is a different thing and may remain — see the `timeout` semantics below.)
- **"Effective unbounded", stated honestly.** The MCP SDK's `callTool` requires a numeric per-request `timeout` and defaults it to ~60s; there is no documented "disable". So "no client-imposed timeout" is implemented as an **effectively-unbounded** value (24h) plus `resetTimeoutOnProgress`. Task 1 MUST first check whether the installed SDK (`^1.28.0`) supports a true disable (`0`, `undefined`, `Infinity`, or `maxTotalTimeout` semantics); if it does, use that and reword; otherwise use the large value and label it "effectively unbounded (SDK requires a number)".
- **Keep the agent's cancellation.** The existing `withAbort(options.signal)` in `McpClientAdapter.callTool` is cancellation propagation (abort the tool call when the whole request is aborted) — NOT a timeout we invented. Leave it untouched.
- **Influence is opt-in.** For the YAML/server path, a wait hint is a STATIC entry in the existing `mcp.headers` (already flows to the wrapper) — no new code needed there. A programmatic/dynamic wait hint uses the new swappable `IMcpRequestHeadersStrategy` (ISP — a new focused interface; default no-op → contributes nothing). The strategy is threaded through `McpConnectionConfig.requestHeadersStrategy` (code-only; never parsed from YAML), which the builder factory path (`createDefaultMcpClient`) copies into the wrapper. **The direct server/YAML path (`connectMcpClientsFromConfig`, `SmartServerMcpConfig`) is NOT extended** — its config is YAML-parsed and cannot carry a code strategy; YAML users convey wait hints via static `mcp.headers`. (Extending the server config types for a code strategy is deliberately out of scope; see Notes.)
- **SDK version:** `@modelcontextprotocol/sdk ^1.28.0`. The implementer MUST verify `Client.callTool(params, resultSchema?, options?: RequestOptions)` and `RequestOptions` (`timeout`, `resetTimeoutOnProgress`, `maxTotalTimeout`) against the installed version (`node_modules/@modelcontextprotocol/sdk`) before finalizing, and adapt to the actual names/positions.
- ESM `.js` imports, TS strict, Biome, `noUnusedLocals: true`, interfaces `I`-prefixed, additive/backward-compatible (don't break `McpConnectionConfig`/`MCPClientConfig` consumers).
- **SCOPED lint gate per task:** `npx @biomejs/biome check --write <changed files>` → `npm run lint:check` **exit 0**. NOT the global `npm run format`.
- **Commit ONLY this task's files:** `git status --short`, `git add` explicit paths (NOT `-A`/`.`).
- **Release:** after all tasks, bump to **20.3.0** (the `v20.2.0` tag is pushed but NOT published — do NOT touch it). npm publish stays user-only (yubikey).

---

## File Structure

- `packages/llm-agent-mcp/src/client.ts` — **(Task 1, 2, 3)** `MCPClientWrapper`: (1) pass `RequestOptions` to the SDK `callTool` so the SDK's ~60s does NOT fire; (2) remove the transport `requestInit.signal` per-request cutoff + the connect-bound, and DEPRECATE `MCPClientConfig.timeout` (kept, unwired); (3) merge `requestHeadersStrategy` headers via the `buildHttpTransportOptions` helper.
- `packages/llm-agent/src/interfaces/mcp-request-headers-strategy.ts` — **(Task 3, create)** `IMcpRequestHeadersStrategy` (+ barrel export).
- `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts` — **(Task 3, modify)** add `requestHeadersStrategy?: IMcpRequestHeadersStrategy` to `McpConnectionConfig` (code-only field).
- `packages/llm-agent-mcp/src/no-op-request-headers-strategy.ts` — **(Task 3, create)** `NoopMcpRequestHeadersStrategy`.
- `packages/llm-agent-mcp/src/factory.ts` — **(Task 3, modify)** `createDefaultMcpClient` copies `config.requestHeadersStrategy` into the wrapper. (The direct server path in `smart-server.ts` is intentionally NOT modified — see Global Constraints.)
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

`client.ts` ~263 sets `signal: AbortSignal.timeout(this.config.timeout || 30000)` on the transport `requestInit` — a one-shot wall-clock abort created at connect that can cut off a long tool call (a second stacked timeout). Remove it. Do NOT add a replacement connect-bound: a `Promise.race`-style guard would leave the underlying `connect()` running after the caller got a rejection (leaked transport/socket, later state mutation), and the SDK connect has no clean abort seam here. Connection availability is already governed by the connection-strategy layer (Periodic/Lazy reconnect + readiness, #201-205). The now-unused public `MCPClientConfig.timeout` is DEPRECATED (kept for backward-compat, no longer wired).

**Files:** modify `packages/llm-agent-mcp/src/client.ts` (~115 doc + ~254-278 connect); extend `mcp-client-request-timeout.test.ts`.

**Steps:**

- [ ] **Failing test (pure helper — the only source of transport options).** Factor a pure exported helper `buildHttpTransportOptions(config: Pick<MCPClientConfig,'headers'|'sessionId'>): { sessionId?: string; requestInit: { headers: Record<string,string> } }` that returns the object passed to `new StreamableHTTPClientTransport(url, ...)`. It sets `requestInit.headers` (`Accept` + `...config.headers`) and NO `signal`. Test:
  - `buildHttpTransportOptions({ headers: { A: '1' } }).requestInit.signal === undefined`;
  - `.requestInit.headers.Accept === 'application/json, text/event-stream'` and `.requestInit.headers.A === '1'`.
  Because the transport construction will call THIS helper as its ONLY way to build the options, there is no inline `requestInit` left to forget — a unit test on the helper is sufficient to pin "no per-request signal". (Task 3 extends this helper to also merge the strategy headers.)
- [ ] Run → FAILS (helper doesn't exist; today the inline `requestInit` sets a `signal`).
- [ ] **Implement.**
  - Add `buildHttpTransportOptions(...)` and construct the transport with it: `new StreamableHTTPClientTransport(new URL(this.config.url), buildHttpTransportOptions(this.config))`. Remove the inline `requestInit` object entirely (no `signal`).
  - **Remove the connect-bound** — call `await this.client.connect(httpTransport)` directly (no `withConnectTimeout`, no `AbortSignal.timeout` around it). Do NOT re-introduce a per-connect race guard.
  - Change the `MCPClientConfig.timeout` doc comment (~115) to: `/** @deprecated No longer used. MCP self-governs its request timeouts; this field is retained only for backward compatibility and has no effect. */`
- [ ] Run tests → GREEN. `npm run build`. Existing suites green. SCOPED lint gate. Commit: `fix(mcp): drop the transport per-request signal + connect-bound; deprecate timeout (MCP governs its own timeouts)`.

---

### Task 3 — `IMcpRequestHeadersStrategy` (no-op default) threaded through both construction paths

**Files:** create `packages/llm-agent/src/interfaces/mcp-request-headers-strategy.ts` + barrel export; modify `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts` (add field); create `packages/llm-agent-mcp/src/no-op-request-headers-strategy.ts`; modify `packages/llm-agent-mcp/src/client.ts` (config field + merge via `buildHttpTransportOptions`) and `packages/llm-agent-mcp/src/factory.ts`; test `packages/llm-agent-mcp/src/__tests__/mcp-request-headers-strategy.test.ts`. (Do NOT modify `smart-server.ts` — the server/YAML path is out of scope per Global Constraints.)

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
- [ ] **Failing test (header merge).** Extend the Task 2 helper to accept the strategy: `buildHttpTransportOptions(config: Pick<MCPClientConfig,'headers'|'sessionId'|'requestHeadersStrategy'>)`. Test: `buildHttpTransportOptions({ headers: { A: '1' }, requestHeadersStrategy: { headers: () => ({ 'X-Wait': '600' }) } }).requestInit.headers` includes `Accept`, `A: '1'`, AND `X-Wait: '600'`; with no strategy the headers are `{ Accept, A: '1' }` (unchanged); `.requestInit.signal === undefined` still holds.
- [ ] **Failing test (propagation via a PURE mapping helper — no module mock, no ctor spy).** Add a pure exported helper in `factory.ts`: `toMcpClientWrapperConfig(config: McpConnectionConfig): ConstructorParameters<typeof MCPClientWrapper>[0]` that maps `McpConnectionConfig` → the wrapper options object (transport/url/command/args/headers AND `requestHeadersStrategy`). Test it directly (no network): `toMcpClientWrapperConfig({ type: 'http', url: 'u', requestHeadersStrategy: s }).requestHeadersStrategy === s`, and for `type: 'stdio'` it carries no url. Then `createDefaultMcpClient` MUST build the wrapper via `new MCPClientWrapper(toMcpClientWrapperConfig(config))` — so testing the pure helper pins the propagation without spying the ctor or hitting `wrapper.connect()`.
- [ ] Run → FAILS (helper doesn't exist / merge not implemented).
- [ ] **Implement.**
  - `client.ts`: add `requestHeadersStrategy?: IMcpRequestHeadersStrategy;` to `MCPClientConfig` (doc comment). In `buildHttpTransportOptions`, merge `...(config.requestHeadersStrategy?.headers() ?? {})` LAST into `requestInit.headers` (after `...config.headers`). Rely on `?.` (no ctor default needed).
  - `factory.ts`: add the pure `toMcpClientWrapperConfig(config)` helper (carrying `requestHeadersStrategy` for the http branch) and make `createDefaultMcpClient` construct the wrapper via it: `const wrapper = new MCPClientWrapper(toMcpClientWrapperConfig(config));`.
- [ ] Run tests → GREEN. `npm run build` (all packages, cross-package types). SCOPED lint gate. Commit: `feat(mcp): IMcpRequestHeadersStrategy (no-op default) threaded through the factory path`.

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
- **Scope of the strategy:** the strategy is threaded ONLY through the builder→factory path (`McpConnectionConfig.requestHeadersStrategy` → `createDefaultMcpClient` → wrapper). The direct-server/YAML path (`connectMcpClientsFromConfig` / `SmartServerMcpConfig`) is deliberately NOT extended — YAML cannot express a code strategy, and those users convey wait hints via static `mcp.headers` (which already reaches the wrapper). A server-composition seam for a code strategy can be a follow-up if a consumer needs it. NOTE: the primary fix (Tasks 1-2, removing the imposed timeout) IS universal — it lives in `MCPClientWrapper`, so it benefits the server/YAML path too (this is what fixes the live `(no response)`).
- No agent-level LLM timeouts change. The agent's `withAbort(options.signal)` cancellation stays.
