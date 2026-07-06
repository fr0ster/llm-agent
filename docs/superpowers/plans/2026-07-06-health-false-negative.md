# /health False-Negative Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task is one commit; run the pinning tests and the SCOPED lint gate before committing.

**Goal:** Stop `/health` returning `503` (`status: unhealthy`) for a *working* LLM whose configured model name is a valid alias not literally present in the provider's `/models` listing.

**Architecture:** Four small, independent changes, model: **503 = readiness (can the server serve? MCP ready?)**, and **LLM health = a best-effort component signal in the body**, never a hard 503 gate. (C) fix the brittle `getModels`-model-in-list health probe; (B) demote LLM-soft-failure to `degraded`; (A) gate `503` on `!ready` only; (D) log the probe cause instead of swallowing it.

**Tech Stack:** TypeScript (ESM, `.js` imports), `node:test` + `tsx`, Biome. Packages `@mcp-abap-adt/llm-agent-libs` (health + adapter) and `@mcp-abap-adt/llm-agent-server-libs` (http route).

## Global Constraints

- **Confirmed root cause (live-verified):** `LlmAdapter.healthCheck` (`packages/llm-agent-libs/src/adapters/llm-adapter.ts:449-477`) calls `provider.getModels()` then returns `{ ok: true, value: found }` where `found` = the configured model literally appears in the `/models` list. Deepseek: `getModels()` succeeds → `["deepseek-v4-flash","deepseek-v4-pro"]`; configured model `"deepseek-chat"` is a valid working alias **not** in that list → `found=false` → `value:false` → `agent-health` `llm = hc.ok && hc.value = false` → `health-checker.ts:56` `!llmOk → 'unhealthy'` → `health-route-handler.ts:14` `status==='unhealthy' || !ready → 503`.
- **Behavior-preserving where it matters:** the `/health` JSON shape (`{status, uptime, version, timestamp, components:{llm,rag,mcp}, ready, ...}`) is UNCHANGED. The **MCP-not-ready ⇒ 503** behavior (readiness gate) is UNCHANGED. Only the LLM-soft-health → `unhealthy`/`503` path is fixed.
- **CRITICAL — `rc.ready` is the readiness gate, independent of `components.mcp`.** `rc.ready` is set at `smart-server.ts:2335` as `isReadinessReporter(smartAgent) ? smartAgent.isReady() : true` — the MCP-connection readiness reporter from feature #205 (NOT the `components.mcp` health-snapshot probe). It gates BOTH `/health` (route handler) AND the **chat/messages pre-dispatch request gate** (`smart-server.ts` ~2458 and ~2490: `if (!rc.ready) { … 503 … }`). Because after this plan the ONLY 503 trigger is `!rc.ready`, and MCP-not-connected ⇒ `isReady()===false` ⇒ `rc.ready===false`, the fail-loud "MCP down ⇒ 503" behavior is preserved on BOTH surfaces. **This plan must NOT touch the pre-dispatch gates in `smart-server.ts`** (they already 503 on `!rc.ready`); Task 5 guards this explicitly. Do NOT conflate `components.mcp[].ok` (a soft body signal) with `rc.ready` (the hard serve-gate).
- ESM `.js` imports, TS strict, Biome. `noUnusedLocals: true`.
- **Lint gate per task (SCOPED — NOT global `npm run format`):** `npx @biomejs/biome check --write <changed files for THIS task>` → `npm run lint:check` requiring **exit code 0**. Do NOT grep for "Found 0 errors".
- **Commit ONLY this task's files:** `git status --short`, `git add` explicit paths (NOT `-A`/`.`).
- Each task ends in exactly one commit. TDD: add/extend a unit test first.
- **Release is held** — these changes ship in the next version alongside the #212 fix; do not publish.

---

## File Structure

- `packages/llm-agent-libs/src/adapters/llm-adapter.ts` — **(C)** `healthCheck`: reachable `getModels()` ⇒ `value:true`; drop the `found` gate.
- `packages/llm-agent-libs/src/health/health-checker.ts` — **(B)** `!llmOk` folds into `degraded`, not `unhealthy`.
- `packages/llm-agent-server-libs/src/smart-agent/http/health-route-handler.ts` — **(A)** HTTP `503` on `!ready` only.
- `packages/llm-agent-libs/src/health/agent-health.ts` — **(D)** log the probe cause instead of silent `catch {}`.
- Tests: `packages/llm-agent-libs/src/adapters/__tests__/llm-adapter.test.ts` (C), `packages/llm-agent-libs/src/health/__tests__/health-checker.test.ts` (B), a new route-handler test (A), `agent-health` test (D).

---

### Task 1 — (C) `LlmAdapter.healthCheck`: reachable `getModels()` ⇒ healthy

THE main fix. A reachable provider (its `getModels()` resolves without throwing) is healthy; do NOT report unhealthy merely because the configured model string is absent from the `/models` list (aliases / deployment names are common and legitimate).

**Files:** modify `packages/llm-agent-libs/src/adapters/llm-adapter.ts` (the `healthCheck` method, ~449-477); test `packages/llm-agent-libs/src/adapters/__tests__/llm-adapter.test.ts`.

**Interfaces:** `healthCheck(options?: CallOptions): Promise<Result<boolean, LlmError>>` (signature unchanged).

**Steps:**

- [ ] **Failing test first.** In `llm-adapter.test.ts`, add a `describe('LlmAdapter — healthCheck')` with cases (stub the provider via the adapter's provider seam — mirror the existing adapter tests' provider stubbing):
  - reachable + model NOT in list → healthy: provider `getModels: async () => [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }]`, `model: 'deepseek-chat'` → `healthCheck()` resolves `{ ok: true, value: true }`.
  - reachable + model IN list → healthy: `getModels` returns `[{ id: 'deepseek-chat' }]` → `{ ok: true, value: true }`.
  - no `getModels` → healthy: provider without `getModels` → `{ ok: true, value: true }` (unchanged behavior).
  - `getModels` throws → unhealthy: provider `getModels: async () => { throw new Error('boom'); }` → `{ ok: false }` (`error.code === 'HEALTH_CHECK_FAILED'` or the propagated `LlmError`).
- [ ] Run → the "model NOT in list → healthy" case FAILS on current code (returns `value:false`).
- [ ] **Implement.** Replace the `found` computation + return in `healthCheck` (~462-469) so a successful `getModels()` is healthy regardless of whether the configured model is listed. Keep the abort + try/catch. New body of the `try` (after obtaining `models`):

  ```ts
      // A reachable provider is healthy. The configured model may be a valid
      // alias or deployment name that the /models listing does not enumerate
      // (e.g. deepseek "deepseek-chat" vs listed "deepseek-v4-*"), so do NOT
      // gate health on the model literally appearing in the list — that
      // false-negatives a working LLM. Whether the model is listed is kept only
      // as a debug signal.
      const model = this.provider.model;
      const listed = models.some((m) =>
        typeof m === 'string'
          ? m === model || m.includes(model)
          : m.id === model || m.id.includes(model),
      );
      if (!listed) {
        options?.sessionLogger?.logStep('llm_health_model_not_listed', {
          model,
          listedCount: models.length,
        });
      }
      return { ok: true, value: true };
  ```
  (The `catch` block stays exactly as-is: `getModels()` throwing ⇒ `{ ok: false, error }`.)
- [ ] Run the new tests → GREEN. Run the existing `llm-adapter.test.ts` + `llm-adapter-embedding-models.test.ts` → still GREEN.
- [ ] `npm run build`. SCOPED lint gate. Commit: `fix(llm-adapter): healthCheck reports a reachable LLM healthy even when the configured model alias is absent from /models`.

---

### Task 2 — (B) `HealthChecker`: LLM-soft-failure ⇒ `degraded`, not `unhealthy`

**Files:** modify `packages/llm-agent-libs/src/health/health-checker.ts` (the status block, ~55-62); test `packages/llm-agent-libs/src/health/__tests__/health-checker.test.ts`.

**Steps:**

- [ ] **Failing test first.** In `health-checker.test.ts`, add cases. NOTE: the existing tests build a **real** `new SmartAgent(deps, DEFAULT_CONFIG)` (heavier; its snapshot is driven by real deps). To assert the status-mapping branch in isolation, construct the `HealthChecker` with a **minimal fake agent cast to SmartAgent** whose `healthCheck()` returns the chosen snapshot — do NOT try to steer a real SmartAgent's snapshot:

  ```ts
  const fakeAgent = {
    healthCheck: async () => ({
      ok: true as const,
      value: { llm: false, rag: true, mcp: [] as { name: string; ok: boolean }[] },
    }),
  } as unknown as import('../../agent.js').SmartAgent;
  const checker = new HealthChecker({
    agent: fakeAgent,
    startTime: Date.now(),
    version: 'test',
  });
  const s = await checker.check();
  assert.equal(s.status, 'degraded');
  ```
  Cover with this fake-cast approach:
  - `llm:false, rag:true, mcp:[]` → `status === 'degraded'` (was `'unhealthy'`).
  - `llm:true, rag:false, mcp:[]` → `status === 'degraded'` (unchanged).
  - `llm:true, rag:true, mcp:[{ok:true}]` → `status === 'healthy'` (unchanged).
  - `llm:false, rag:false` → `status === 'degraded'`.
- [ ] Run → the first case FAILS (current code yields `'unhealthy'`).
- [ ] **Implement.** Replace the status decision (~55-62) so LLM-unhealthy folds into `degraded`:

  ```ts
      let status: 'healthy' | 'degraded' | 'unhealthy';
      if (!llmOk || !ragOk || !mcpAllOk || anyCircuitOpen) {
        // A soft component signal (LLM/RAG/MCP/circuit) ⇒ degraded, not
        // unhealthy. Inability to SERVE is expressed via readiness (ready:false
        // ⇒ 503), handled by the route; /health status stays a body signal.
        status = 'degraded';
      } else {
        status = 'healthy';
      }
  ```
  (The `'unhealthy'` literal stays in the union type for backward compatibility of the `HealthStatus` shape; it is simply no longer produced here.)
- [ ] Run tests → GREEN. `npm run build`. SCOPED lint gate. Commit: `fix(health): LLM/RAG/MCP soft failures report degraded, not unhealthy`.

---

### Task 3 — (A) health route: HTTP `503` on `!ready` only

**Files:** modify `packages/llm-agent-server-libs/src/smart-agent/http/health-route-handler.ts` (line ~14); new test `packages/llm-agent-server-libs/src/smart-agent/http/__tests__/health-route-handler.test.ts`.

**Steps:**

- [ ] **Failing test first.** Create `http/__tests__/health-route-handler.test.ts`. Build a minimal `rc` (route context) with a fake `healthChecker.check()` returning a chosen status + a `res` stub capturing `writeHead(code)` and `end(body)`, and a `ready` flag. Cases:
  - `status:'unhealthy', ready:true` → `writeHead` called with **200** (this is the behavior change: current code 503s on `status==='unhealthy'`).
  - `status:'degraded', ready:true` → **200** (unchanged — asserted for completeness).
  - `status:'healthy', ready:true` → **200**.
  - `ready:false` (any status, e.g. `'healthy'`) → **503** (readiness gate unchanged).
  - body still contains `{ ...status, ready }` (shape unchanged).
  (Read the current `health-route-handler.ts` to match the exact `rc` fields it reads: `rc.healthChecker`, `rc.ready`, `rc.res`.)
- [ ] Run → the `unhealthy, ready:true → 200` case FAILS (current line `status.status === 'unhealthy' || !rc.ready ? 503 : 200` 503s it). NOTE: after Task 2 nothing produces `'unhealthy'`, so this task also removes the now-dead `status==='unhealthy'` branch, making "503 = readiness only" explicit and future-proof.
- [ ] **Implement.** Change the HTTP-code line (currently `const httpCode = status.status === 'unhealthy' || !rc.ready ? 503 : 200;`) to gate on readiness only:

  ```ts
    // 503 == NOT READY (can't serve, e.g. MCP down). LLM/RAG/circuit soft
    // signals surface in the body (status: degraded) but do NOT 503 a service
    // that can still serve — a load balancer must not drop a working pod.
    const httpCode = rc.ready ? 200 : 503;
  ```
- [ ] Run tests → GREEN. `npm run build`. SCOPED lint gate. Commit: `fix(http/health): return 503 only when not ready; degraded LLM stays 200`.

---

### Task 4 — (D) `agent-health`: log the probe cause instead of swallowing it

**Files:** modify `packages/llm-agent-libs/src/health/agent-health.ts` (the `catch {}` blocks + the llm value path); test `packages/llm-agent-libs/src/health/__tests__/agent-health.test.ts` (create if absent, else extend).

**Steps:**

- [ ] **Failing test first.** In an `agent-health` test, call `buildAgentHealthSnapshot(mainLlm, ragStores, [], options)` with:
  - a `mainLlm.healthCheck` that throws → assert `results.llm === false` AND `options.sessionLogger.logStep` was called once with a step name `'health_llm_probe_error'` and a `{ reason }` payload.
  - a `mainLlm.healthCheck` returning `{ ok: false, error: { message: 'x' } }` → `results.llm === false` and the same log fires.
- [ ] Run → FAILS (no logging today; `catch {}` is silent).
- [ ] **Implement.** In `agent-health.ts`, replace the silent `catch {}` for the LLM probe and log the not-ok result. The llm block becomes:

  ```ts
    try {
      if (mainLlm.healthCheck) {
        const hc = await mainLlm.healthCheck(options);
        results.llm = hc.ok && hc.value;
        if (!results.llm) {
          options?.sessionLogger?.logStep('health_llm_probe_error', {
            reason: hc.ok ? 'unhealthy' : String(hc.error?.message ?? hc.error),
          });
        }
      } else {
        const llmRes = await mainLlm.chat(
          [{ role: 'user' as const, content: 'ping' }],
          [],
          options,
        );
        results.llm = llmRes.ok;
        if (!results.llm) {
          options?.sessionLogger?.logStep('health_llm_probe_error', {
            reason: String(llmRes.error?.message ?? llmRes.error),
          });
        }
      }
    } catch (err) {
      results.llm = false;
      options?.sessionLogger?.logStep('health_llm_probe_error', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  ```
  Apply the same pattern to the RAG `catch` (step name `'health_rag_probe_error'`) — keep it minimal; the MCP block already captures per-client `error`, leave it. Verify the `Result` shape field names (`error?.message`) against `LlmError`/`RagError` before finalizing.
- [ ] Run tests → GREEN. `npm run build`. SCOPED lint gate. Commit: `fix(health): log the LLM/RAG probe failure cause instead of swallowing it`.

---

### Task 5 — Readiness regression guard (prove MCP-not-ready ⇒ 503 is preserved)

The whole risk of Tasks 2–3 is accidentally weakening the fail-loud readiness gate. This task proves it is intact. No product code changes here.

**Files:** none modified (guard only) — optionally extend `http/__tests__/health-route-handler.test.ts`.

**Steps:**

- [ ] **Confirm the pre-dispatch gates are UNTOUCHED.** `git diff main...HEAD -- packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` must be EMPTY (this plan does not touch `smart-server.ts`). Grep the two chat/messages pre-dispatch gates still read `if (!rc.ready)` → 503 (`smart-server.ts` ~2458 and ~2490). If `smart-server.ts` shows in the diff, STOP and report.
- [ ] **Route test already covers `/health` 503 on `!ready`** (Task 3's `ready:false → 503` case). Confirm it is present and green.
- [ ] **Live readiness verification** (the fail-loud end-to-end). Start the built server pointed at an UNREACHABLE MCP so the readiness reporter reports not-ready, then assert BOTH surfaces 503:
  - config: a minimal controller/flat YAML with `mcp: { type: http, url: http://127.0.0.1:1/mcp/stream/http }` (unreachable), on a spare port, `--env-path .env`.
  - After startup (do NOT wait for ready — it never becomes ready): `GET /health` → **503** with body `ready:false`; `POST /v1/chat/completions` (any prompt) → **503** (pre-dispatch gate), NOT a 200 with `(no response)`.
  - Stop the server. Record the two status codes in the task report.
  - (If the reporter defaults ready:true when no MCP strategy is present, use a config that DOES attach an MCP connection strategy so `isReady()` can be false — mirror the repro used in issue #213 validation but with an unreachable MCP url.)
- [ ] No commit needed if nothing changed; if the route test was extended, commit: `test(http/health): guard MCP-not-ready ⇒ /health + pre-dispatch 503`.

---

## Notes

- After Task 1 alone, the reported deepseek case is fixed (healthCheck ⇒ `value:true` ⇒ `llm:true` ⇒ `healthy` ⇒ 200). Tasks 2–3 make ANY LLM-soft-failure non-fatal (defense-in-depth); Task 4 restores observability. All four are behavior-preserving for the readiness (503) path and the `/health` JSON shape.
- No provider files change (the earlier "add healthCheck to providers" idea is unnecessary — the adapter already has one; the bug was its `found` gate).
