# MCP Timeout Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task ends in exactly one commit; run the pinning tests and the SCOPED lint gate before committing.

**Goal:** Stop the agent from imposing its own timeout on MCP tool calls — MCP self-governs its timeouts by default; the only (opt-in) influence is request headers, conveyed either by the existing static `mcp.headers` pass-through or by a consumer-owned strategy.

> **⚠️ GOVERNING MODEL — read `## Amendment A` (end of file) FIRST.** Live acceptance (Task 6) found that a 24h "effective unbounded" timeout hangs the server on a stuck MCP call. **Amendment A (Tasks 7-10) SUPERSEDES the timeout decisions of Tasks 1-2**: we KEEP a client-side MCP request timeout, but GENEROUS (default 120000 ms = 2 min) + consumer-configurable + PER-TOOL overrides (`toolTimeouts`), threaded through builder AND YAML/server paths. `MCPClientConfig.timeout` is NOT deprecated — it is the knob. Tasks 1-2 are committed (the SDK-RequestOptions plumbing + transport-signal/connect-bound removal stand); only their 24h value and the `timeout` deprecation are reversed by Task 7. Tasks 3-4 (header strategy, no-op default) are KEPT unchanged.

**Architecture:** Timeouts are an ownership boundary. The agent already cancels an MCP call via the request's `AbortSignal` at the adapter level (`McpClientAdapter.callTool` wraps the call in `withAbort(options.signal)`). On top of that, the MCP SDK applies its OWN built-in ~60s per-request timeout (because `MCPClientWrapper.callTool` passes no `RequestOptions`), AND the HTTP transport sets a second `AbortSignal.timeout(...)` on `requestInit`. Those two are the redundant "stack" that cut off a slow-but-working MCP call (`-32001` → silent `(no response)` on heavy reviews). This plan removes BOTH imposed cutoffs so the MCP server governs its own timeout, deprecates the now-unused `timeout` config (no longer wired; kept for backward-compat), and adds a focused, swappable `IMcpRequestHeadersStrategy` (default no-op) threaded through the builder→factory path (`McpConnectionConfig` → `createDefaultMcpClient`), so a programmatic consumer can convey a "willing to wait" header — the sanctioned cross-isolation influence. The direct server/YAML path is not extended (YAML can't carry a code strategy); its wait hints use static `mcp.headers`, and it inherits the universal timeout fix because that lives in `MCPClientWrapper`.

**Tech Stack:** TypeScript (ESM `.js` imports), `node:test` + `tsx`, Biome. Packages: `@mcp-abap-adt/llm-agent` (the new `I*` interface + the `McpConnectionConfig` field), `@mcp-abap-adt/llm-agent-mcp` (`MCPClientWrapper`, factory, no-op strategy), `@mcp-abap-adt/llm-agent-libs` (builder DI seam). The direct server/YAML MCP path (`llm-agent-server-libs`) is NOT modified (out of scope — YAML can't carry a code strategy). SDK: `@modelcontextprotocol/sdk ^1.28.0`.

## Global Constraints

- **Timeout ownership (the binding principle):** the agent times out ONLY what it owns (LLM / our operations). It MUST NOT impose its own timeout on an MCP tool call OR on connect. Checking a timeout at BOTH the MCP level AND the agent level is the forbidden stack. Default behaviour: **MCP self-governs** — we impose no client-side request cutoff on the tool call and no connect-bound (connection availability is governed by the connection-strategy layer, #201-205). The public `MCPClientConfig.timeout` is DEPRECATED (kept for backward-compat, no longer wired).
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

### Task 2 — remove the transport per-request cutoff + connect-bound; deprecate `timeout`

`client.ts` ~263 sets `signal: AbortSignal.timeout(this.config.timeout || 30000)` on the transport `requestInit` — a one-shot wall-clock abort created at connect that can cut off a long tool call (a second stacked timeout). Remove it. Do NOT add a replacement connect-bound: a `Promise.race`-style guard would leave the underlying `connect()` running after the caller got a rejection (leaked transport/socket, later state mutation), and the SDK connect has no clean abort seam here. Connection availability is already governed by the connection-strategy layer (Periodic/Lazy reconnect + readiness, #201-205). The now-unused public `MCPClientConfig.timeout` is DEPRECATED (kept for backward-compat, no longer wired).

**Files:** modify `packages/llm-agent-mcp/src/client.ts` (~115 doc + ~254-278 connect); extend `mcp-client-request-timeout.test.ts`.

**Steps:**

- [ ] **Failing test (pure helper — the only source of transport options).** Factor a pure exported helper that takes an ALREADY-RESOLVED session id (do NOT read `config.sessionId` inside — the caller resolves it via `_sessionForConnect()` so live server-assigned ids survive reconnect): `buildHttpTransportOptions(opts: { headers?: Record<string,string>; sessionId?: string }): { sessionId?: string; requestInit: { headers: Record<string,string> } }`. It sets `requestInit.headers` (`Accept` + `...opts.headers`), NO `signal`, and passes `sessionId` straight through. Test:
  - `buildHttpTransportOptions({ headers: { A: '1' } }).requestInit.signal === undefined`;
  - `.requestInit.headers.Accept === 'application/json, text/event-stream'` and `.requestInit.headers.A === '1'`;
  - `buildHttpTransportOptions({ sessionId: 'live-123' }).sessionId === 'live-123'` (passed through verbatim).
  Because the transport construction calls THIS helper as its ONLY way to build the options, there is no inline `requestInit` left to forget. (Task 3 extends the opts with `requestHeadersStrategy` for the header merge.)
- [ ] **Failing test (session-resume — regression guard).** Prove the LIVE server-assigned session id is used on reconnect, not the initial `config.sessionId`. Construct the wrapper with `config.sessionId = 'init'`, set `wrapper['sessionId'] = 'live-999'` (simulating a server-assigned id captured on a prior connect at client.ts:281-282), then assert `wrapper['_sessionForConnect']() === 'live-999'` AND that the value the wrapper feeds into `buildHttpTransportOptions` at connect is `'live-999'`. (Assert via the transport-options the wrapper builds: extract a tiny `wrapper['_httpTransportOptions']()` or inline-verify the connect passes `_sessionForConnect()` — read the connect region to pick the cleanest seam; the point is a test that FAILS if the helper is fed `config.sessionId` instead of `_sessionForConnect()`.)
- [ ] Run → FAILS (helper doesn't exist; today the inline `requestInit` sets a `signal`).
- [ ] **Implement.**
  - Add `buildHttpTransportOptions(...)` and construct the transport with it, passing the RESOLVED session id: `new StreamableHTTPClientTransport(new URL(this.config.url), buildHttpTransportOptions({ headers: this.config.headers, sessionId: this._sessionForConnect() }))`. Remove the inline `requestInit` object entirely (no `signal`). Do NOT change `_sessionForConnect()` or the `this.sessionId` capture at ~281-282.
  - **Remove the connect-bound** — call `await this.client.connect(httpTransport)` directly (no `withConnectTimeout`, no `AbortSignal.timeout` around it). Do NOT re-introduce a per-connect race guard.
  - Change the `MCPClientConfig.timeout` doc comment (~115) to: `/** @deprecated No longer used. MCP self-governs its request timeouts; this field is retained only for backward compatibility and has no effect. */`
- [ ] Run tests → GREEN. `npm run build`. Existing suites green (esp. any session-resume test). SCOPED lint gate. Commit: `fix(mcp): drop the transport per-request signal + connect-bound; deprecate timeout (MCP governs its own timeouts)`.

---

### Task 3 — `IMcpRequestHeadersStrategy` (no-op default) threaded through the factory path

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
- [ ] **Failing test (header merge).** Extend the Task 2 helper opts to accept the strategy: `buildHttpTransportOptions(opts: { headers?: Record<string,string>; sessionId?: string; requestHeadersStrategy?: IMcpRequestHeadersStrategy })`. Test: `buildHttpTransportOptions({ headers: { A: '1' }, requestHeadersStrategy: { headers: () => ({ 'X-Wait': '600' }) } }).requestInit.headers` includes `Accept`, `A: '1'`, AND `X-Wait: '600'`; with no strategy the headers are `{ Accept, A: '1' }` (unchanged); `.requestInit.signal === undefined` still holds. At the call site, pass `requestHeadersStrategy: this.config.requestHeadersStrategy` alongside `headers`/`sessionId`.
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

- [ ] Grep for the current MCP timeout/headers wording (`rg -n "timeout|headers|mcp:" docs/EXAMPLES.md packages/llm-agent-mcp/README.md`). Add a short accurate note: the engine imposes NO client-side request timeout on MCP tool calls — the MCP server governs its own; `MCPClientConfig.timeout` is DEPRECATED (no effect; retained for backward-compat). To convey a "willing to wait" hint: YAML/server users add a header under the existing `mcp.headers`; programmatic users can supply a custom `IMcpRequestHeadersStrategy` (default no-op) via `withMcpRequestHeadersStrategy`. State the capability; invent no new YAML keys. NOTE the exact file is `packages/llm-agent-mcp/README.md` (NOT `src/README.md`).
- [ ] `npm run lint:check` exit 0. Commit: `docs(mcp): MCP self-governs request timeouts; timeout deprecated; wait hints via headers/strategy`.

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

---

## Amendment A — per-tool CONFIGURABLE timeout (SUPERSEDES the 24h "effective unbounded" of Tasks 1-2)

**Why (live-verified):** Task 6 showed the 24h effective-unbounded timeout turns a stuck/orphaned MCP call (a `fetch failed` → reconnect that leaves the pending call unsettled) into an INDEFINITE server hang (process holds the port but stops accepting). The ~60s SDK default was a safety net masking that. **Decision (user):** keep a client-side MCP request timeout as the safety net, but GENEROUS and consumer-configurable, with PER-TOOL overrides (some MCP tools legitimately take 5–15 min). Default **120000 ms (2 min)**. `resetTimeoutOnProgress: true` stays (progress-reporting tools extend). This keeps ONE timeout (the callTool `RequestOptions.timeout`) — the transport-signal + connect-bound removal (Tasks 2) stays, so there is no stack.

Config is PLAIN DATA (numbers/map) → it flows through BOTH the builder path AND the YAML/server path (unlike the code-only header strategy). Header strategy (Tasks 3-4) is KEPT as-is (orthogonal opt-in, no-op default).

### Task 7 — resolve a per-tool timeout in `callTool` (amends Tasks 1-2 code)

**Files:** `packages/llm-agent-mcp/src/client.ts`; test `packages/llm-agent-mcp/src/__tests__/mcp-client-request-timeout.test.ts`.

**Steps:**
- [ ] **Failing tests first** (extend the timeout test): assert `resolveToolTimeout('T', {})` === `120000`; `resolveToolTimeout('T', { timeout: 300000 })` === `300000`; `resolveToolTimeout('SlowTool', { timeout: 120000, toolTimeouts: { SlowTool: 900000 } })` === `900000` (per-tool wins); and the callTool spy passes `options.timeout === resolveToolTimeout(name, config)` + `resetTimeoutOnProgress === true`.
- [ ] **Implement** in `client.ts`:
  - Replace `const MCP_NO_CLIENT_TIMEOUT_MS = 24*60*60*1000;` with `export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 120_000;`
  - Add `toolTimeouts?: Record<string, number>;` to `MCPClientConfig` (doc: per-tool MCP request-timeout overrides in ms, keyed by tool name).
  - UN-deprecate `timeout` — doc comment: `/** Default per-call MCP request timeout in ms (default 120000 = 2 min). Per-tool overrides via toolTimeouts. resetTimeoutOnProgress extends it while a tool reports progress. */`
  - Add an exported pure helper: `export function resolveToolTimeout(name: string, config: Pick<MCPClientConfig, 'timeout' | 'toolTimeouts'>): number { return config.toolTimeouts?.[name] ?? config.timeout ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS; }`
  - In `callTool` `performCall`, pass `{ timeout: resolveToolTimeout(toolCall.name, this.config), resetTimeoutOnProgress: true }` as the SDK RequestOptions (replacing the 24h const).
- [ ] Run tests → GREEN. Existing mcp suites green. `npm run build` → SCOPED lint → commit: `fix(mcp): per-tool configurable MCP request timeout (default 120s), not effectively-unbounded`.

### Task 8 — thread `timeout` + `toolTimeouts` through ALL construction paths (builder + YAML/server)

**Files:** `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts` (add fields to `McpConnectionConfig`); `packages/llm-agent-mcp/src/factory.ts` (`toMcpClientWrapperConfig` carry them); `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (add fields to `SmartServerMcpConfig` ~160; `connectMcpClientsFromConfig` ~543 pass them into the wrapper); the YAML MCP parse in `packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts` (carry `timeout`/`toolTimeouts` from raw YAML into the parsed MCP config); builder path already flows `McpConnectionConfig` (no builder change needed beyond the field existing). Tests where each path resolves.

**Steps:**
- [ ] Add `timeout?: number;` + `toolTimeouts?: Record<string, number>;` to `McpConnectionConfig` and `SmartServerMcpConfig`.
- [ ] `factory.ts` `toMcpClientWrapperConfig`: on the http branch add `...(config.timeout !== undefined ? { timeout: config.timeout } : {})` and `...(config.toolTimeouts ? { toolTimeouts: config.toolTimeouts } : {})`.
- [ ] `smart-server.ts` `connectMcpClientsFromConfig` (~543, http branch): add `timeout: cfg.timeout` and `toolTimeouts: cfg.toolTimeouts` to the `new MCPClientWrapper({...})` options.
- [ ] YAML parse (`resolve-config-sections.ts`): READ how it maps raw `mcp:` YAML → the MCP config objects; carry `timeout` and `toolTimeouts` through (they are plain data). If a config-validator enumerates allowed mcp keys, add `timeout`/`toolTimeouts` there too (grep `config-validator.ts` for the mcp key allow-list).
- [ ] **Failing tests:** (a) `toMcpClientWrapperConfig({ type:'http', url:'u', timeout: 300000, toolTimeouts: { X: 900000 } })` carries both; (b) a YAML-parse test: an `mcp:` block with `timeout`/`toolTimeouts` resolves to a `SmartServerMcpConfig` carrying them (mirror an existing resolve-config-sections MCP test). Then implement.
- [ ] Run tests → GREEN. `npm run build` (all packages) → SCOPED lint → commit: `feat(mcp): thread timeout + toolTimeouts through builder + YAML/server construction paths`.

### Task 9 — docs (amends Task 5)

**Files:** `docs/EXAMPLES.md` + `packages/llm-agent-mcp/README.md`.
- [ ] Update the MCP-timeout note: the engine applies a GENEROUS default per-call MCP request timeout (**120000 ms**) as a safety net against a stuck/hung tool call; it is consumer-configurable via `mcp.timeout` (default for that MCP) and per-tool overrides via `mcp.toolTimeouts: { <toolName>: ms }` (some tools legitimately take 5–15 min); `resetTimeoutOnProgress` extends it while a tool reports progress. Show the YAML shape (the `mcp:` block with `timeout` + `toolTimeouts`). Remove the "deprecated/no effect" wording for `timeout`. Keep the header-strategy note (server-side wait hint). Commit: `docs(mcp): per-tool configurable MCP request timeout (default 120s)`.

### Task 10 — live acceptance (re-run; supersedes Task 6)

- [ ] Build. Start `.run/skills-review-github.yaml` (optionally add `toolTimeouts` for slow ABAP tools, e.g. source/where-used fetchers, at 600000–900000). Send the `ZDAZ_R_DELAYED_UPDATE` controller review (object that EXISTS on :3001). Assert: a REAL non-empty review (NOT `(no response)`); the run completes; the server stays RESPONSIVE afterward (`/health` 200 — no hang); no indefinite stall. If a genuine tool timeout fires, it should surface as an error the run handles, not a silent `(no response)` (note if the fail-loud gap still shows — that's the separate deferred follow-up). Record. No commit.

---

## Amendment B — MCP tool-call duration via the STRUCTURED logger (observability, level by run mode)

**Why:** we could not answer "which MCP tool exceeded the timeout" because tool-call durations are not logged. Fix it through the app's EXISTING structured logging so verbosity follows the run mode (a debug-level concern of the logger, not an ad-hoc `console.warn` + env flag). The `ILogger`/`LogEvent` union already DEFINES `{ type: 'tool_call'; traceId; toolName; isError; durationMs }` but nothing emits it; the per-session debug channel `options.sessionLogger?.logStep(name, data)` already carries `coordinator_step_*` etc. Use these — the logger implementation / run mode decides how loud a `tool_call` / debug step is surfaced.

### Task 11 — emit MCP tool-call timing through the existing structured logger

**Files:** the tool-execution site(s) in `packages/llm-agent-libs/src` where a tool is actually invoked AND a structured `ILogger` (`deps.logger`, the thing that emits `llm_call`/`pipeline_done`) and/or `ctx.options.sessionLogger` + `traceId` are in scope — i.e. the flat/linear/dag tool loop (`packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts` and its caller that holds the logger) and the controller execution (`packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`). Test(s) alongside.

**Design (NO ad-hoc console.warn, NO new env flag — reuse the structured channels):**
- **READ first** where an existing `LogEvent` is emitted (grep `packages/llm-agent-libs/src` for the site that logs `type: 'llm_call'` / `type: 'pipeline_done'` — that call site holds the `ILogger` and the `traceId`). MCP tool calls run through `client.callTool(name, args, options)` in the tool loop; measure `Date.now()` around THAT call.
- **Emit the already-defined structured event** at that site on each tool call: `logger.log({ type: 'tool_call', traceId, toolName: name, isError: <result was an error>, durationMs })`. This is THE event designed for this; the server logger writes it, and run-mode verbosity is the logger's concern (satisfies "different informativeness by run mode").
- **Also emit a per-session debug step** where `ctx.options?.sessionLogger` is in scope (the debug channel, like `coordinator_step_*`): `ctx.options.sessionLogger?.logStep('mcp_tool_call', { toolName: name, durationMs, isError, timeoutMs: <resolved limit if available> })`. This is the "debug log" the user asked for — it lands in the per-session artifacts, verbose by run mode. Include the resolved timeout limit when reachable so a `durationMs ≈ timeoutMs` clearly identifies which tool to bump via `toolTimeouts`.
- If only ONE of the two channels is cleanly in scope at a given site, emit that one; do NOT invent a new logger or thread one where none exists (avoid a large plumbing change — prefer the site that ALREADY has the logger). Do NOT change timeout behaviour, `resolveToolTimeout`, the header strategy, or re-add any signal/connect-bound.

**Steps:**
- [ ] **Locate the emission site** (where `llm_call`/`pipeline_done` are logged, and/or where `sessionLogger` + the `client.callTool` are both in scope). Confirm the `traceId` source there.
- [ ] **Failing test first:** with a fake `ILogger` (captures `log()` calls) and/or a fake `sessionLogger` (captures `logStep`), drive one tool call through the tool loop and assert a `tool_call` event (`toolName`, `durationMs` a number ≥ 0, `isError` correct) and/or an `mcp_tool_call` debug step is emitted. Assert `isError: true` when the tool call fails. Mirror an existing tool-loop test's harness.
- [ ] Run → FAIL. **Implement** the emission at the located site(s). Run → GREEN. Existing pipeline/controller tests still green. `npm run build` → SCOPED lint gate → commit: `feat(obs): emit MCP tool-call timing (tool_call event + mcp_tool_call debug step) — diagnose slow tools / tune toolTimeouts`.
- [ ] **Doc:** in `packages/llm-agent-mcp/README.md` (or EXAMPLES.md) note that MCP tool-call durations are logged as `tool_call` structured events + `mcp_tool_call` session-debug steps (visible at debug/verbose run levels), and that a `durationMs` near a tool's resolved timeout indicates it should be raised via `toolTimeouts`.
