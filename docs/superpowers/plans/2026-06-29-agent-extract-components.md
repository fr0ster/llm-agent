# Agent.ts Component Extraction (PR-2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task follows TDD-by-characterization (baseline GREEN → extract → GREEN — no RED step, since these are behavior-preserving moves pinned by existing tests), runs the exit-code lint gate, and ends with exactly one `refactor:` commit. This is a **behavior-preserving refactor**: move method bodies BYTE-FOR-BYTE; the only edits are `this.<field>`→parameter/registry threading. No observable behavior change in `process` / `streamProcess` / `healthCheck`.

## Goal

Extract 5 reusable, interface-bounded components from the god-object
`packages/llm-agent-libs/src/agent.ts` (2161 lines, the `SmartAgent` class) into
focused modules, per the APPROVED merged blueprint
(`docs/superpowers/specs/2026-06-26-monolith-audit.md` → `## Blueprint: agent.ts`).
This is **PR-2a = slices 1-5** of that blueprint. Slice 6 (the `runToolLoop` /
`ToolLoopHandler` convergence) is a SEPARATE later PR (PR-2b) and is **NOT** in
scope here.

## Architecture

`SmartAgent` is the highest-fan-in class in `llm-agent-libs` (~16 direct
importers). After this PR it becomes a thinner orchestrator that *consumes* five
extracted collaborators (Principle 2 — "the app IS the example"):

| Slice | Responsibility | Extract target | New module |
|---|---|---|---|
| 1 (R4) | structured-pipeline delegation | `pipelineToStream` free fn (REUSE `IPipeline`) | `pipeline/pipeline-to-stream.ts` |
| 2 (R8) | MCP tool listing + connection resolution | `McpToolRegistry` / `IMcpToolRegistry` (REUSE `IMcpConnectionStrategy`); removes `_activeClients` field | `mcp/tool-registry.ts` |
| 3 (R3) | pass-through transparent proxy | `runPassThrough` free fn | `pipeline/handlers/pass-through.ts` |
| 4 (R7) | health-check probe body | `buildAgentHealthSnapshot` / `IAgentHealthProbe` | `health/agent-health.ts` |
| 5 (R2) | RAG fan-out + context assembly | `RagOrchestrator` / `IRagOrchestrator` (REUSE `IContextAssembler`/`IReranker`/`IQueryExpander`/`IRag`) | `agent/rag-orchestrator.ts` |

The `_runStreamingToolLoop` method (R1, ~764 lines) STAYS in `agent.ts`
unchanged-in-substance — it is PR-2b's convergence target. Tasks 2 and 5 only
re-thread its `_listAllTools(...)` call sites to the registry (the method is a
`SmartAgent` member in `agent.ts`; the off-limits file is
`pipeline/handlers/tool-loop.ts`, which is NOT touched at all in this PR).

## Tech Stack

- TypeScript strict, ESM only (`.js` extensions in imports), Node ≥ 22.
- Biome for lint/format (2 spaces, single quotes, always semicolons).
- `tsconfig.base.json` sets `noUnusedLocals: true` — a leftover import after an
  extraction is a **build error**. A `export { x } from './m.js'` re-export does
  NOT consume a local `import { x }` binding.
- Test runner (from `packages/llm-agent-libs/package.json`):
  `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`.
  - **Suite:** `npm test -w @mcp-abap-adt/llm-agent-libs`
  - **Single file:** `cd packages/llm-agent-libs && node --import tsx/esm --test --test-reporter=spec src/__tests__/<file>.test.ts`
  - **Build:** `npm run build -w @mcp-abap-adt/llm-agent-libs`
- Tests live in `packages/llm-agent-libs/src/__tests__/` (health tests in
  `src/health/__tests__/`).

## Global Constraints (binding — copy verbatim into every worker's context)

- **PR-2b is the `runToolLoop` convergence — `pipeline/handlers/tool-loop.ts` is
  NOT touched here.** Do not open, edit, or delete it. `_runStreamingToolLoop`
  (the SmartAgent method in `agent.ts`) is likewise NOT extracted in this PR; it
  only has its `_listAllTools` call sites re-threaded to the registry (Tasks 2/5).
- **Each PR = a complete concern.** This PR is the 5 non-tool-loop extractions
  (slices 1-5). It must build, lint clean, and pass the full suite at every commit.
- **Behavior-preserving:** move bodies BYTE-FOR-BYTE; the only edits are
  `this.<field>`→parameter/registry threading. No observable behavior change in
  `process` / `streamProcess` / `healthCheck`.
- **Public API byte-stable.** These symbols MUST stay importable from `agent.ts`
  (barrel re-export if a symbol relocates):
  `SmartAgent`, `SmartAgentDeps`, `SmartAgentConfig`,
  `SmartAgentReconfigureOptions`, `SmartAgentRagStores`, `OrchestratorError`
  (+ the already re-exported `AgentCallOptions`, `SmartAgentResponse`,
  `StopReason`). ~16 importers across the monorepo — their import paths must NOT
  change. All public `SmartAgent` method signatures (`process`, `streamProcess`,
  `healthCheck`, `isReady`, `reconfigure`, `applyConfigUpdate`, `addRagStore`,
  `removeRagStore`, `closeSession`, `getActiveConfig`, `getAgentConfig`,
  `currentMainLlm`) stay byte-identical.
- The new component modules are **NOT** added to a public barrel
  (`src/index.ts`) unless an importer needs them. Default: do not add them
  (verified — no external importer needs them in PR-2a).
- **R6/R5 facades stay in `SmartAgent`** — do NOT extract `reconfigure`,
  `applyConfigUpdate`, `closeSession`, `addRagStore`, `removeRagStore`,
  `getActiveConfig`, `getAgentConfig`. They are already slim delegating facades.
- The module-scope helpers `mergeSignals` and `createTimeoutSignal`
  (`agent.ts` ~202-224) **stay in `agent.ts`** — still used by `streamProcess`'s
  timeout path (lines ~679-681). Do not move them.
- **Lint gate per task (in order):**
  1. `npm run format`
  2. `npx @biomejs/biome check --write <changed files>`
  3. `npm run lint:check` — requires **exit code 0** (warnings/infos are fine;
     this repo has ~38 pre-existing warnings). Do NOT grep stdout for
     "Found 0 errors." — Biome prints no such line when clean; a grep gate is a
     false red. Gate strictly on the exit code.
- **Build + test gate per task:** `npm run build -w @mcp-abap-adt/llm-agent-libs`
  succeeds, then the task's pin test(s) and the full suite
  (`npm test -w @mcp-abap-adt/llm-agent-libs`) are GREEN. Baseline GREEN BEFORE
  each task, GREEN AFTER.
- **One PR, 5 commits = 5 tasks**, in the fixed order 1→5 (dependency-ordered,
  lowest-risk first). Each task ends in exactly one `refactor:` commit (Task 5
  also adds a new gap test — fold the `test:` change into the same Task-5 commit).
- Do NOT commit this plan file. Do NOT run `npm publish`.

## File Structure

```
packages/llm-agent-libs/src/
  agent.ts                              # MODIFIED in every task (call-site rethread + deletions)
  pipeline/
    pipeline-to-stream.ts               # NEW (Task 1)
    handlers/
      pass-through.ts                   # NEW (Task 3)
  mcp/                                  # NEW directory (Task 2)
    tool-registry.ts                    # NEW (Task 2)
  health/
    agent-health.ts                     # NEW (Task 4)
  agent/                                # NEW directory (Task 5)
    rag-orchestrator.ts                 # NEW (Task 5)
  __tests__/
    rag-orchestrator.test.ts            # NEW gap/characterization test (Task 5)
```

No changes to `src/index.ts` (new modules are internal).

---

### Task 1 — `pipelineToStream` (R4, very low risk)

Extract `SmartAgent._runStructuredPipeline` (the `deps.pipeline` adapter that
turns `IPipeline.execute`'s callback-push API into an async generator via a
queue + `resolveWait`) into a free function. Zero field deps — it reads only
`this.deps.pipeline` (passed as a parameter).

**Files**
- NEW `packages/llm-agent-libs/src/pipeline/pipeline-to-stream.ts`
- MODIFY `packages/llm-agent-libs/src/agent.ts`

**Pin test:** `issue-164-hotswap-usage-model.test.ts` and
`builder-coordinator-dispatch-default.test.ts` (both drive `streamProcess`
through a configured `deps.pipeline`).

**Interfaces / signature**
```ts
export function pipelineToStream(
  pipeline: IPipeline,
  input: string | Message[],
  externalTools: LlmTool[],
  opts: CallOptions | undefined,
): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>
```
(`IPipeline` is `import type { IPipeline } from '../interfaces/pipeline.js'`.)

Steps:
- [ ] Confirm baseline GREEN: `npm test -w @mcp-abap-adt/llm-agent-libs`.
- [ ] Create `pipeline/pipeline-to-stream.ts`. Imports:
  ```ts
  import type {
    CallOptions,
    LlmStreamChunk,
    LlmTool,
    Message,
    Result,
  } from '@mcp-abap-adt/llm-agent';
  import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
  import type { IPipeline } from '../interfaces/pipeline.js';
  ```
- [ ] Move the BODY of `_runStructuredPipeline` (`agent.ts` ~2099-2159)
  byte-for-byte into the new async generator. The original signature has unused
  `_parentSpan`/`_sessionId` params (prefixed `_`) — DROP them (they are dead).
  Edits only: `this.deps.pipeline` → the `pipeline` parameter. Keep the guard
  as `if (!pipeline) return;`. The body is:
  ```ts
  export async function* pipelineToStream(
    pipeline: IPipeline,
    input: string | Message[],
    externalTools: LlmTool[],
    opts: CallOptions | undefined,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    if (!pipeline) return;
    const history = typeof input === 'string' ? [] : input;
    const chunkQueue: Result<LlmStreamChunk, OrchestratorError>[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;
    const executorPromise = pipeline
      .execute(input, history, opts, (chunk) => {
        chunkQueue.push(chunk);
        if (resolveWait) { resolveWait(); resolveWait = null; }
      }, externalTools)
      .then(() => {
        done = true;
        if (resolveWait) { resolveWait(); resolveWait = null; }
      })
      .catch((err) => {
        chunkQueue.push({
          ok: false,
          error: new OrchestratorError(String(err), 'PIPELINE_ERROR'),
        });
        done = true;
        if (resolveWait) { resolveWait(); resolveWait = null; }
      });
    while (!done || chunkQueue.length > 0) {
      if (chunkQueue.length > 0) {
        const chunk = chunkQueue.shift();
        if (chunk !== undefined) yield chunk;
      } else if (!done) {
        await new Promise<void>((r) => { resolveWait = r; });
      }
    }
    await executorPromise;
  }
  ```
  (This is the exact existing logic; the only delta from the source is the
  parameter rename `textOrMessages`→`input` and dropping the two unused span/
  sessionId params.)
- [ ] In `agent.ts`, add `import { pipelineToStream } from './pipeline/pipeline-to-stream.js';`.
- [ ] In `streamProcess`, replace the delegation block (~804-816). Current:
  ```ts
  if (this.deps.pipeline) {
    const stream = this._runStructuredPipeline(
      textOrMessages, externalTools, opts, rootSpan, sessionId,
    );
    for await (const chunk of stream) yield chunk;
    rootSpan.setStatus('ok');
    rootSpan.end();
    return;
  }
  ```
  becomes:
  ```ts
  if (this.deps.pipeline) {
    const stream = pipelineToStream(this.deps.pipeline, textOrMessages, externalTools, opts);
    for await (const chunk of stream) yield chunk;
    rootSpan.setStatus('ok');
    rootSpan.end();
    return;
  }
  ```
- [ ] DELETE the `_runStructuredPipeline` method (~2099-2159) from `SmartAgent`.
- [ ] Verify no now-unused imports remain in `agent.ts` (`IPipeline` stays —
  still the type of `SmartAgentDeps.pipeline`; `Message`/`LlmTool`/`Result`/
  `LlmStreamChunk` all still used elsewhere). Build to confirm
  (`noUnusedLocals` catches a leftover).
- [ ] Lint gate (format → biome check --write → `lint:check` exit 0) on
  `agent.ts` + `pipeline/pipeline-to-stream.ts`.
- [ ] Build + run pins + full suite GREEN.
- [ ] Commit: `refactor(agent): extract pipelineToStream adapter (PR-2a slice 1)`.

---

### Task 2 — `McpToolRegistry` (R8, low risk)

Extract `_listAllTools` + `_resolveActiveClients` + `_revectorizeTools` behind a
new `IMcpToolRegistry` + `McpToolRegistry` class. The registry OWNS the mutable
client list, so the `_activeClients` field is REMOVED from `SmartAgent`. REUSE
`IMcpConnectionStrategy` (catalog) for connection resolution.

**Files**
- NEW `packages/llm-agent-libs/src/mcp/tool-registry.ts`
- MODIFY `packages/llm-agent-libs/src/agent.ts`

**Pin tests:** `mcp-reconnection.test.ts`, `mcp-clients-di.test.ts`.

**Verified shapes (from real code):**
- `McpConnectionResult` (in `@mcp-abap-adt/llm-agent`) = `{ clients: IMcpClient[]; toolsChanged: boolean }`.
- `IMcpConnectionStrategy.resolve(currentClients, options?) => Promise<McpConnectionResult>`.
- `_listAllTools` returns `{ tools: McpTool[]; toolClientMap: Map<string, IMcpClient> }` — this is `ToolRegistryResult`.

**ALL readers of `_activeClients` / the 3 methods (must be re-threaded):**
- field decl `244`, init `271`
- `_resolveActiveClients` body `286/289` (R/W)
- `healthCheck` `536` — `this._activeClients.map(...)` (this task: `→ getActiveClients()`; Task 4 relocates it)
- `streamProcess` `844` — `const hasMcpClients = this._activeClients.length > 0;`
- `_listAllTools` `2015` — `this._activeClients.map(...)`
- `_resolveActiveClients` callers: `streamProcess` `841`, inside `_listAllTools` `2011`
- `_listAllTools` callers: `streamProcess` `938`, `_preparePipeline` `1240`,
  `_runStreamingToolLoop` `1337` and `1446`

**Interfaces / class**
```ts
export interface ToolRegistryResult {
  tools: McpTool[];
  toolClientMap: Map<string, IMcpClient>;
}
export interface IMcpToolRegistry {
  resolve(opts?: CallOptions): Promise<ToolRegistryResult>;
  resolveActiveClients(opts?: CallOptions): Promise<void>;
  getActiveClients(): IMcpClient[];
}
```
The interface exposes the FULL seam — all three methods are the agent's one
cohesive MCP-tool surface (ISP is about not bolting *unrelated* methods onto an
interface, not about minimizing to one). `McpToolRegistry implements
IMcpToolRegistry`. Both `SmartAgent` (its `mcpToolRegistry` field) AND
`RagOrchestratorDeps.mcpToolRegistry` (Task 5) are typed as the **interface**
`IMcpToolRegistry`, NOT the concrete class — so consumers depend on the interface
(Principle 3) and Task 5's gap test can pass a structural fake (the concrete class
has a `private activeClients` field, which would make a structural fake
non-assignable to the class type).

Steps:
- [ ] Confirm baseline GREEN.
- [ ] Create `mcp/tool-registry.ts`. Imports:
  ```ts
  import type {
    CallOptions,
    IMcpClient,
    IRag,
    McpTool,
  } from '@mcp-abap-adt/llm-agent';
  import type { IMcpConnectionStrategy } from '../interfaces/mcp-connection-strategy.js';
  ```
  (Type `ragStores` as `Record<string, IRag>` — structurally equal to
  `SmartAgentRagStores` — to avoid importing back from `agent.ts`.)
- [ ] Implement the class, moving the three method bodies byte-for-byte
  (`this._activeClients`→`this.activeClients`, `this.deps.connectionStrategy`→
  `this.connectionStrategy`, `this.deps.ragStores`→`this.ragStores`):
  ```ts
  export class McpToolRegistry implements IMcpToolRegistry {
    private activeClients: IMcpClient[];
    constructor(
      initialClients: IMcpClient[],
      private readonly connectionStrategy: IMcpConnectionStrategy | undefined,
      private readonly ragStores: Record<string, IRag>,
    ) {
      this.activeClients = [...initialClients];
    }
    getActiveClients(): IMcpClient[] {
      return this.activeClients;
    }
    async resolveActiveClients(opts?: CallOptions): Promise<void> {
      if (!this.connectionStrategy) return;
      const result = await this.connectionStrategy.resolve(this.activeClients, opts);
      this.activeClients = result.clients;
      if (result.toolsChanged) {
        await this.revectorizeTools(result.clients, opts);
      }
    }
    private async revectorizeTools(clients: IMcpClient[], opts?: CallOptions): Promise<void> {
      const toolsRag = this.ragStores.tools ?? Object.values(this.ragStores)[0];
      if (!toolsRag) return;
      for (const client of clients) {
        const result = await client.listTools(opts);
        if (!result.ok) continue;
        for (const tool of result.value) {
          const text = `Tool: ${tool.name} — ${tool.description}`;
          await toolsRag.writer?.()?.upsertRaw(`tool:${tool.name}`, text, {});
        }
      }
    }
    async resolve(opts?: CallOptions): Promise<ToolRegistryResult> {
      await this.resolveActiveClients(opts);
      const tools: McpTool[] = [];
      const toolClientMap = new Map<string, IMcpClient>();
      const settled = await Promise.allSettled(
        this.activeClients.map(async (client) => ({
          client,
          result: await client.listTools(opts),
        })),
      );
      for (const e of settled) {
        if (e.status === 'fulfilled' && e.value.result.ok) {
          for (const t of e.value.result.value) {
            if (!toolClientMap.has(t.name)) {
              tools.push(t);
              toolClientMap.set(t.name, e.value.client);
            }
          }
        }
      }
      return { tools, toolClientMap };
    }
  }
  ```
  NOTE: `resolve()` calls `resolveActiveClients()` internally — preserving the
  existing double-resolve at `streamProcess` (line 841 then line 938 via
  `_listAllTools`). This is byte-equivalent to today; do not "optimize" it away.
- [ ] In `agent.ts`: add `import { McpToolRegistry, type IMcpToolRegistry } from './mcp/tool-registry.js';`.
- [ ] Remove the `private _activeClients: IMcpClient[];` field decl (244). Add
  `private readonly mcpToolRegistry: IMcpToolRegistry;` (typed as the interface —
  Principle 3; constructed as `new McpToolRegistry(...)`).
- [ ] In the constructor, replace `this._activeClients = [...deps.mcpClients];`
  (271) with:
  ```ts
  this.mcpToolRegistry = new McpToolRegistry(
    deps.mcpClients,
    deps.connectionStrategy,
    deps.ragStores,
  );
  ```
  (Pass the live `deps.ragStores` object reference so runtime `addRagStore`
  mutations remain visible to revectorize — matches today's late-read of
  `this.deps.ragStores`.)
- [ ] DELETE `_resolveActiveClients`, `_revectorizeTools`, `_listAllTools` from
  `SmartAgent`.
- [ ] Re-thread all call sites:
  - `streamProcess` `841`: `await this._resolveActiveClients(opts);` →
    `await this.mcpToolRegistry.resolveActiveClients(opts);`
  - `streamProcess` `844`: `this._activeClients.length` →
    `this.mcpToolRegistry.getActiveClients().length`
  - `streamProcess` `938`: `await this._listAllTools(opts)` →
    `await this.mcpToolRegistry.resolve(opts)`
  - `_preparePipeline` `1240`: `await this._listAllTools(opts)` →
    `await this.mcpToolRegistry.resolve(opts)`
  - `_runStreamingToolLoop` `1337` and `1446`: `await this._listAllTools(opts)` →
    `await this.mcpToolRegistry.resolve(opts)` (these are inside the SmartAgent
    method in `agent.ts` — allowed; `tool-loop.ts` is untouched)
  - `healthCheck` `536`: `this._activeClients.map(...)` →
    `this.mcpToolRegistry.getActiveClients().map(...)` (Task 4 relocates this
    whole block; for now just rethread so the build is green)
- [ ] Verify `agent.ts` imports: `IMcpClient` still used (`toolClientMap` types
  in `_preparePipeline` / `_runStreamingToolLoop`), `McpTool` still used (loop
  param types), `IMcpConnectionStrategy` still used (type of
  `SmartAgentDeps.connectionStrategy`). No removal expected; build to confirm.
- [ ] Lint gate on `agent.ts` + `mcp/tool-registry.ts`.
- [ ] Build + pins (`mcp-reconnection`, `mcp-clients-di`) + full suite GREEN.
- [ ] Commit: `refactor(agent): extract McpToolRegistry, remove _activeClients field (PR-2a slice 2)`.

---

### Task 3 — `runPassThrough` (R3, low risk)

Extract the `mode === 'pass'` branch of `streamProcess` (transparent LLM proxy:
stream chunks, strip intermediate usage, emit terminal usage summary; no tools,
no RAG) into a free async generator. Two deps only: `this._mainLlm`,
`this.requestLogger`.

**Files**
- NEW `packages/llm-agent-libs/src/pipeline/handlers/pass-through.ts`
- MODIFY `packages/llm-agent-libs/src/agent.ts`

**Pin test:** `pass-usage.test.ts`.

**Interface / signature**
```ts
export function runPassThrough(
  llm: ILlm,
  requestLogger: IRequestLogger,
  messages: Message[],
  externalTools: LlmTool[],
  opts: CallOptions | undefined,
): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>
```

**Behavior-preservation note (span lifecycle):** the `rootSpan` is left in the
caller. The original `pass` branch yields its chunk sequence and then does
`rootSpan.setStatus('ok'); rootSpan.end(); return;` (on both the normal and the
error-chunk exits). `runPassThrough` yields the IDENTICAL chunk sequence
(including the error-chunk-then-early-return); the caller wraps it with the
`rootSpan` calls. The chunk sequence the consumer observes is unchanged, and
`rootSpan.end()` is still called twice (once here, once in the `finally`) — same
as today.

Steps:
- [ ] Confirm baseline GREEN.
- [ ] Create `pipeline/handlers/pass-through.ts`. Imports:
  ```ts
  import type {
    CallOptions,
    ILlm,
    IRequestLogger,
    LlmStreamChunk,
    LlmTool,
    Message,
    Result,
  } from '@mcp-abap-adt/llm-agent';
  import type { OrchestratorError } from '@mcp-abap-adt/llm-agent';
  import { summaryToUsage } from '../../logger/session-request-logger.js';
  ```
- [ ] Move the pass-branch body (`agent.ts` ~723-797) byte-for-byte. Edits only:
  `this._mainLlm`→`llm`, `this.requestLogger`→`requestLogger`. DROP the
  `rootSpan.setStatus('ok'); rootSpan.end();` calls (caller keeps them) and DROP
  the message-building lines (`messages` is now a parameter). The
  `opts?.sessionLogger?.logStep('client_request', ...)` line at 722 stays in the
  caller (it needs `textOrMessages`). Result:
  ```ts
  export async function* runPassThrough(
    llm: ILlm,
    requestLogger: IRequestLogger,
    messages: Message[],
    externalTools: LlmTool[],
    opts: CallOptions | undefined,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    const passStart = Date.now();
    const traceId2 = opts?.trace?.traceId;
    const stream = llm.streamChat(messages, externalTools, opts);
    let passContent = '';
    const passToolCalls: unknown[] = [];
    let accPrompt = 0;
    let accCompletion = 0;
    let accTotal = 0;
    let hasUsage = false;
    const logPassUsage = (): void => {
      if (!hasUsage) return;
      requestLogger.logLlmCall({
        component: 'tool-loop',
        model: llm.model ?? 'unknown',
        promptTokens: accPrompt,
        completionTokens: accCompletion,
        totalTokens: accTotal,
        durationMs: Date.now() - passStart,
        requestId: traceId2,
      });
    };
    for await (const chunk of stream) {
      if (!chunk.ok) {
        logPassUsage();
        yield chunk;
        return;
      }
      if (chunk.value.reset) {
        passContent = '';
        passToolCalls.length = 0;
        continue;
      }
      if (chunk.value.content) passContent += chunk.value.content;
      if (chunk.value.toolCalls) passToolCalls.push(...chunk.value.toolCalls);
      if (chunk.value.usage) {
        accPrompt += chunk.value.usage.promptTokens;
        accCompletion += chunk.value.usage.completionTokens;
        accTotal += chunk.value.usage.totalTokens;
        hasUsage = true;
      }
      const { usage: _omitUsage, ...rest } = chunk.value;
      yield { ok: true, value: rest };
    }
    opts?.sessionLogger?.logStep('llm_response_pass', {
      content: passContent,
      toolCalls: passToolCalls.length > 0 ? passToolCalls : undefined,
    });
    logPassUsage();
    const passSummary = traceId2 ? requestLogger.getSummary(traceId2) : undefined;
    yield {
      ok: true,
      value: {
        content: '',
        finishReason: 'stop',
        ...(passSummary
          ? { usage: { ...summaryToUsage(passSummary), models: passSummary.byModel } }
          : {}),
      },
    };
  }
  ```
- [ ] In `agent.ts`, add `import { runPassThrough } from './pipeline/handlers/pass-through.js';`.
- [ ] Replace the `if (mode === 'pass') { ... }` block (~717-801). The original
  declares `const messages: Message[]` which shadows the outer `messages` (694)
  — use `passMessages` to avoid the conflict:
  ```ts
  if (mode === 'pass') {
    const passMessages: Message[] =
      typeof textOrMessages === 'string'
        ? [{ role: 'user' as const, content: textOrMessages }]
        : textOrMessages;
    opts?.sessionLogger?.logStep('client_request', { textOrMessages });
    for await (const chunk of runPassThrough(
      this._mainLlm, this.requestLogger, passMessages, externalTools, opts,
    )) {
      yield chunk;
    }
    rootSpan.setStatus('ok');
    rootSpan.end();
    return;
  }
  ```
- [ ] Verify `agent.ts` imports: `summaryToUsage` STAYS (still used by
  `_runStreamingToolLoop` at ~1322/1680/1796/1838). `Message`/`LlmTool` stay.
  Build to confirm `noUnusedLocals`.
- [ ] Lint gate on `agent.ts` + `pipeline/handlers/pass-through.ts`.
- [ ] Build + pin (`pass-usage`) + full suite GREEN.
- [ ] Commit: `refactor(agent): extract runPassThrough handler (PR-2a slice 3)`.

---

### Task 4 — `buildAgentHealthSnapshot` (R7, low-med; depends on Task 2)

Extract the per-component probe body of `healthCheck` (LLM ping-or-`.healthCheck`,
RAG first-store, MCP-client fan-out) DOWNWARD into a pure function.
`SmartAgent.healthCheck` becomes a thin wrapper that owns the timeout/abort
merge, then calls the probe with the merged options and the client list from the
Task-2 `McpToolRegistry`. Do **NOT** delegate to `HealthChecker`
(`health-checker.ts:30` already calls `agent.healthCheck()` — delegating up
would recurse). `HealthChecker` stays untouched. `isReady()` stays as-is (REUSE
`IReadinessReporter`).

**Files**
- NEW `packages/llm-agent-libs/src/health/agent-health.ts`
- MODIFY `packages/llm-agent-libs/src/agent.ts`

**Pin test:** `agent-readiness.test.ts`.

**Interface / signature**
```ts
export interface AgentHealthSnapshot {
  llm: boolean;
  rag: boolean;
  mcp: { name: string; ok: boolean; error?: string }[];
}
export type IAgentHealthProbe = (
  mainLlm: ILlm,
  ragStores: Record<string, IRag>,
  activeClients: IMcpClient[],
  options: CallOptions,
) => Promise<AgentHealthSnapshot>;
export const buildAgentHealthSnapshot: IAgentHealthProbe = async (...) => { ... };
```
`options` is the already-merged `healthOptions` (signal + `maxTokens: 1`); the
wrapper owns `createTimeoutSignal`/`mergeSignals` (those helpers stay in
`agent.ts`, still used by `streamProcess`). This keeps the probe free of the
signal helpers (no circular import back to `agent.ts`).

Steps:
- [ ] Confirm baseline GREEN.
- [ ] Create `health/agent-health.ts`. Imports:
  ```ts
  import type {
    CallOptions,
    ILlm,
    IMcpClient,
    IRag,
  } from '@mcp-abap-adt/llm-agent';
  ```
- [ ] Move the three probe try-blocks (`agent.ts` ~504-575) byte-for-byte into
  `buildAgentHealthSnapshot`. Edits only: `this._mainLlm`→`mainLlm`,
  `this.deps.ragStores`→`ragStores`, `this._activeClients.map`→
  `activeClients.map`, and the local `healthOptions`→the `options` parameter.
  The function returns the `results` object (the `AgentHealthSnapshot`), NOT a
  `Result` wrapper:
  ```ts
  export const buildAgentHealthSnapshot: IAgentHealthProbe = async (
    mainLlm, ragStores, activeClients, options,
  ) => {
    const results: AgentHealthSnapshot = { llm: false, rag: false, mcp: [] };
    try {
      if (mainLlm.healthCheck) {
        const hc = await mainLlm.healthCheck(options);
        results.llm = hc.ok && hc.value;
      } else {
        const llmRes = await mainLlm.chat(
          [{ role: 'user' as const, content: 'ping' }], [], options,
        );
        results.llm = llmRes.ok;
      }
    } catch { results.llm = false; }
    try {
      const firstStore = Object.values(ragStores)[0];
      const ragRes = firstStore
        ? await firstStore.healthCheck(options)
        : { ok: true as const, value: undefined };
      results.rag = ragRes.ok;
    } catch { results.rag = false; }
    try {
      const mcpChecks = await Promise.all(
        activeClients.map(async (client) => {
          // ... byte-for-byte from 537-569 ...
        }),
      );
      results.mcp = mcpChecks;
    } catch { /* AbortSignal timeout — leave mcp as empty */ }
    return results;
  };
  ```
  (Copy the MCP per-client body verbatim from the source 537-569.)
- [ ] In `agent.ts`, add `import { buildAgentHealthSnapshot } from './health/agent-health.js';`
  (do NOT import `type AgentHealthSnapshot` — the wrapper keeps the inline literal return type
  and `snapshot`'s type is inferred from the function; an unused type import would fail
  `noUnusedLocals`).
- [ ] Rewrite `healthCheck` to the thin wrapper, KEEPING its public return type
  byte-identical (the inline `{ llm: boolean; rag: boolean; mcp: {...}[] }`
  literal — `AgentHealthSnapshot` is structurally identical, so either spelling
  is wire-compatible; keep the existing literal in the signature to be safe):
  ```ts
  async healthCheck(options?: CallOptions): Promise<
    Result<
      { llm: boolean; rag: boolean; mcp: { name: string; ok: boolean; error?: string }[] },
      OrchestratorError
    >
  > {
    const HEALTH_TIMEOUT_MS = this.config.healthTimeoutMs ?? 5_000;
    const { signal: timeoutSignal, clear: clearTimeout_ } =
      createTimeoutSignal(HEALTH_TIMEOUT_MS);
    const merged = mergeSignals(timeoutSignal, options?.signal);
    const healthOptions: CallOptions = { ...options, signal: merged.signal, maxTokens: 1 };
    try {
      const snapshot = await buildAgentHealthSnapshot(
        this._mainLlm,
        this.deps.ragStores,
        this.mcpToolRegistry.getActiveClients(),
        healthOptions,
      );
      return { ok: true, value: snapshot };
    } finally {
      clearTimeout_();
    }
  }
  ```
  (`AgentHealthSnapshot` assigns to the literal return type — structural match.)
- [ ] Do NOT add `health/agent-health.ts` to `health/index.ts` (no external
  importer needs it).
- [ ] Verify `agent.ts` imports: `createTimeoutSignal`/`mergeSignals` STAY
  (streamProcess timeout). `Result`/`CallOptions`/`OrchestratorError` stay.
  Build to confirm.
- [ ] Lint gate on `agent.ts` + `health/agent-health.ts`.
- [ ] Build + pin (`agent-readiness`) + full suite GREEN. (`HealthChecker` is
  untouched; its tests `health-checker.test.ts`/`health-timeout.test.ts` must
  also stay GREEN — they run in the full suite.)
- [ ] Commit: `refactor(agent): extract buildAgentHealthSnapshot probe (PR-2a slice 4)`.

---

### Task 5 — `RagOrchestrator` (R2, medium; depends on Task 2)

Extract the RAG fan-out + context-assembly coordination from `streamProcess`
(the `smart`/`hard` branch) PLUS `_preparePipeline`, `_toEnglishForRag`,
`_summarizeHistory` into a `RagOrchestrator` behind `IRagOrchestrator`. The two
helpers become module-scope functions injected as optional strategies. REUSE
`IContextAssembler`/`IReranker`/`IQueryExpander`/`IRag`. It calls the Task-2
`McpToolRegistry` for tool listing. Add a NEW characterization test.

**Files**
- NEW `packages/llm-agent-libs/src/agent/rag-orchestrator.ts`
- NEW `packages/llm-agent-libs/src/__tests__/rag-orchestrator.test.ts`
- MODIFY `packages/llm-agent-libs/src/agent.ts`

**Pin tests:** `smart-agent-custom-rag.test.ts`, `tool-reselection.test.ts`,
`builder-tool-selection.test.ts` + the NEW gap test.

**Extracted region:** `streamProcess` lines ~818-1153 (from the
`_preparePipeline` call through the `final_context_assembled` log, i.e.
everything between the structured-pipeline early-return and the
`_runStreamingToolLoop` call), PLUS the bodies of `_preparePipeline`
(~1178-1242), `_toEnglishForRag` (~2033-2053), `_summarizeHistory`
(~2055-2097). The `_runStreamingToolLoop` call (~1156-1168) and `detectedAdapter`
detection (~693-705) STAY in `streamProcess`.

**Interfaces / types**
```ts
export interface RagOrchestratorDeps {
  mainLlm: ILlm;
  helperLlm: ILlm | undefined;
  classifier: ISubpromptClassifier;
  config: SmartAgentConfig;            // type-only import from ../agent.js
  tracer: ITracer;
  metrics: IMetrics;
  reranker: IReranker;
  queryExpander: IQueryExpander;
  sessionManager: ISessionManager;
  toolAvailabilityRegistry: ToolAvailabilityRegistry;
  mcpToolRegistry: IMcpToolRegistry;   // the INTERFACE from ../mcp/tool-registry.js (Task 2) — so the gap test can pass a fake
  requestLogger: IRequestLogger;
  ragStores: Record<string, IRag>;
  embedder: IEmbedder | undefined;
  assembler: IContextAssembler;
  skillManager: ISkillManager | undefined;
  translateQueryStores: Set<string> | undefined;
  /** Optional strategy overrides (default to the module-scope impls). */
  toEnglishForRag?: typeof toEnglishForRag;
  summarizeHistory?: typeof summarizeHistory;
}
export interface OrchestrateOptions {
  opts: CallOptions | undefined;
  rootSpan: ISpan;
  sessionId: string;
  mode: 'hard' | 'pass' | 'smart';
  externalTools: LlmTool[];
}
export interface OrchestratedContext {
  retrieved: { ragResults: Record<string, RagResult[]>; tools: McpTool[] };
  finalTools: LlmTool[];
  skillContent: string;
  assembledMessages: Message[];
  mainAction: Subprompt;
  toolClientMap: Map<string, IMcpClient>;
}
export interface IRagOrchestrator {
  orchestrate(
    input: string | Message[],
    options: OrchestrateOptions,
  ): Promise<Result<OrchestratedContext, OrchestratorError>>;
}
```
NOTE on the signature: the blueprint sketches `orchestrate(query, opts) =>
Promise<OrchestratedContext>`; we wrap in `Result<…, OrchestratorError>` so the
existing prepare-/classifier-/assembler-error YIELDS are preserved exactly
(rest of the codebase uses `Result`). `mainAction` + `toolClientMap` ride in
`OrchestratedContext` because `_runStreamingToolLoop` consumes them; the new gap
test asserts the four documented outputs (`retrieved`, `finalTools`,
`skillContent`, `assembledMessages`).

Steps:
- [ ] Confirm baseline GREEN.
- [ ] Create `agent/rag-orchestrator.ts`. Imports (verified sources):
  ```ts
  import type {
    CallOptions,
    IContextAssembler,
    IEmbedder,
    ILlm,
    IMcpClient,
    IQueryExpander,
    IRag,
    IRequestLogger,
    ISkillManager,
    ISubpromptClassifier,
    LlmTool,
    McpTool,
    Message,
    RagResult,
    Result,
    Subprompt,
  } from '@mcp-abap-adt/llm-agent';
  import { OrchestratorError, QueryEmbedding, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
  import type { IMetrics } from '../metrics/types.js';
  import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
  import type { IReranker } from '../reranker/types.js';
  import type { ISessionManager } from '../session/types.js';
  import type { ISpan, ITracer } from '../tracer/types.js';
  import type { IMcpToolRegistry } from '../mcp/tool-registry.js';
  import type { SmartAgentConfig } from '../agent.js';
  ```
- [ ] Add the two module-scope helper functions (moved byte-for-byte from
  `_toEnglishForRag` / `_summarizeHistory`, with `this.*`→explicit params):
  ```ts
  export async function toEnglishForRag(
    deps: { helperLlm: ILlm | undefined; mainLlm: ILlm; ragTranslatePrompt?: string },
    text: string,
    opts: CallOptions | undefined,
  ): Promise<string> {
    if (/^[\p{ASCII}]+$/u.test(text) || text.length < 15) return text;
    const dp = 'Translate the user request to English for search purposes. Preserve technical terms if present. Reply with only the expanded English terms, no explanation.';
    const llm = deps.helperLlm || deps.mainLlm;
    const res = await llm.chat(
      [{ role: 'system' as const, content: deps.ragTranslatePrompt || dp },
       { role: 'user' as const, content: text }],
      [], opts,
    );
    return res.ok && res.value.content.trim() ? res.value.content.trim() : text;
  }

  export async function summarizeHistory(
    deps: { helperLlm: ILlm | undefined; requestLogger: IRequestLogger; historySummaryPrompt?: string },
    h: Message[],
    opts?: CallOptions,
  ): Promise<Result<Message[], OrchestratorError>> {
    // ... byte-for-byte from _summarizeHistory 2059-2096, this._helperLlm→deps.helperLlm,
    //     this.requestLogger→deps.requestLogger, this.config.historySummaryPrompt→deps.historySummaryPrompt ...
  }
  ```
- [ ] Implement `RagOrchestrator implements IRagOrchestrator`. Constructor stores
  `RagOrchestratorDeps`; `this.toEnglish = deps.toEnglishForRag ?? toEnglishForRag`,
  `this.summarize = deps.summarizeHistory ?? summarizeHistory`. `orchestrate`
  contains, byte-for-byte with `this.<field>`→`this.deps.<field>` (and the two
  helpers via `this.toEnglish(...)`/`this.summarize(...)`, and
  `this._listAllTools`/`this._resolveActiveClients`→`this.deps.mcpToolRegistry`):
  1. The `_preparePipeline` body (classification gate, history auto-summarize via
     `this.summarize`, `mcpToolRegistry.resolve` for `toolClientMap`) → returns
     `{ subprompts, processedHistory, toolClientMap }` or a CLASSIFIER_ERROR Result.
  2. The token-budget gate (`sessionManager.isOverBudget()` → `this.summarize` →
     `sessionManager.reset()`).
  3. `await this.deps.mcpToolRegistry.resolveActiveClients(opts)` then
     `hasMcpClients = this.deps.mcpToolRegistry.getActiveClients().length > 0`.
  4. The retrieval block (~849-1077): translate via `this.toEnglish`, expand,
     per-store embedding (`QueryEmbedding`/`TextOnlyEmbedding`), parallel query,
     rerank, `mcpToolRegistry.resolve` for `mcpTools`, tool selection, skill
     injection → `retrieved`, `finalTools`, `skillContent`.
  5. Tool-availability filter (~1078-1087).
  6. `mainAction` computation (~1090-1110).
  7. `assembler.assemble` (~1111-1135) → on error return an ASSEMBLER_ERROR
     Result (set+end `assembleSpan` exactly as today); skill injection into the
     system message (~1138-1148); `final_context_assembled` log (~1150-1153).
  8. `return { ok: true, value: { retrieved, finalTools, skillContent,
     assembledMessages: assembleResult.value, mainAction, toolClientMap } };`
  All child spans (`classify`, `rag_query`, `assemble`) are created with
  `parent: options.rootSpan` (passed in) — same parenting as today.
- [ ] In `agent.ts`, add `import { RagOrchestrator } from './agent/rag-orchestrator.js';`.
- [ ] In `streamProcess`, replace the default-flow region (~818-1168) — from the
  `_preparePipeline` call up to and including the `_runStreamingToolLoop`
  delegation — with: construct the orchestrator per request (LLMs/classifier are
  read live so hot-swap via `reconfigure` keeps working), call `orchestrate`,
  yield its error if `!ok`, else feed the result into the UNCHANGED
  `_runStreamingToolLoop`:
  ```ts
  const orchestrator = new RagOrchestrator({
    mainLlm: this._mainLlm,
    helperLlm: this._helperLlm,
    classifier: this._classifier,
    config: this.config,
    tracer: this.tracer,
    metrics: this.metrics,
    reranker: this.reranker,
    queryExpander: this.queryExpander,
    sessionManager: this.sessionManager,
    toolAvailabilityRegistry: this.toolAvailabilityRegistry,
    mcpToolRegistry: this.mcpToolRegistry,
    requestLogger: this.requestLogger,
    ragStores: this.deps.ragStores,
    embedder: this.deps.embedder,
    assembler: this.deps.assembler,
    skillManager: this.deps.skillManager,
    translateQueryStores: this.deps.translateQueryStores,
  });
  const orchResult = await orchestrator.orchestrate(textOrMessages, {
    opts, rootSpan, sessionId, mode, externalTools,
  });
  if (!orchResult.ok) {
    rootSpan.setStatus('error', orchResult.error.message);
    rootSpan.end();
    yield orchResult;
    return;
  }
  const { retrieved, finalTools, assembledMessages, mainAction, toolClientMap } = orchResult.value;
  // (skillContent is NOT destructured — the caller doesn't use it; it is already
  //  baked into assembledMessages inside orchestrate(). Destructuring it unused
  //  would trip noUnusedLocals.)
  const stream = this._runStreamingToolLoop(
    mainAction, retrieved, assembledMessages, toolClientMap, opts, rootSpan,
    sessionId, externalTools, finalTools, detectedAdapter,
  );
  for await (const chunk of stream) yield chunk;
  rootSpan.setStatus('ok');
  ```
  (Error-path equivalence: today's prepare-error and assembler-error each do
  `rootSpan.setStatus('error', msg); rootSpan.end(); yield error; return;` — the
  unified branch reproduces that, with the inner `classifySpan`/`assembleSpan`
  set+ended inside `orchestrate` exactly as before.)
- [ ] DELETE `_preparePipeline`, `_toEnglishForRag`, `_summarizeHistory` from
  `SmartAgent`.
- [ ] Verify `agent.ts` imports after deletion: `QueryEmbedding`/
  `TextOnlyEmbedding` STAY (still used in `_runStreamingToolLoop` reselect,
  ~1427-1428); `RagResult`/`Subprompt`/`McpTool`/`IMcpClient` STAY (loop param
  types); `summaryToUsage` STAYS (loop). Fields `_helperLlm`/`_classifier`/
  `reranker`/`queryExpander`/`sessionManager`/`metrics`/`tracer` STAY (read at
  orchestrator construction and/or in the loop; `_classifier` also written by
  `reconfigure`). Build to confirm `noUnusedLocals` — remove any genuinely dead
  import the compiler flags.
- [ ] ADD the gap test `src/__tests__/rag-orchestrator.test.ts`: construct
  `RagOrchestrator` directly with lightweight fakes (a fake `McpToolRegistry`
  exposing `resolve`/`resolveActiveClients`/`getActiveClients`, an in-memory
  `IRag` store seeded with a `tool:` and a `skill:` doc, a stub `assembler` that
  echoes a system+user message, a passthrough `classifier`, noop reranker/
  expander, a fake `embedder`), call `orchestrate('...', { opts: undefined,
  rootSpan: <NoopTracer span>, sessionId: 'default', mode: 'hard',
  externalTools: [] })`, and assert the externally-observable output:
  `retrieved.tools` names, `finalTools` names, `skillContent` contains the
  selected skill, and `assembledMessages` includes the assembled system message
  (with the `## Active Skills` injection when `skillContent` is non-empty).
  Reuse fakes from `@mcp-abap-adt/llm-agent-libs/testing` where available
  (`src/testing/index.ts`). Keep it a pure unit test (no network/LLM).
- [ ] Lint gate on `agent.ts` + `agent/rag-orchestrator.ts` +
  `__tests__/rag-orchestrator.test.ts`.
- [ ] Build + pins (`smart-agent-custom-rag`, `tool-reselection`,
  `builder-tool-selection`) + the new gap test + full suite GREEN.
- [ ] **Post-check sizes:** `wc -l packages/llm-agent-libs/src/agent.ts` (expect ~1400,
  well below 2160) and `wc -l` the 5 new modules. **`agent/rag-orchestrator.ts` MUST stay
  under ~500 lines** — the extracted region is ~335 lines + the 2 helpers (~60), so ~400–450 is
  expected. If it lands at 500+ (e.g. it absorbed more than the named region), STOP and report
  DONE_WITH_CONCERNS — a 700-line orchestrator is itself a monolith and needs its own split-plan,
  NOT a silent oversized new file.
- [ ] Commit: `refactor(agent): extract RagOrchestrator + characterization test (PR-2a slice 5)`.

---

## Done criteria

- `agent.ts` no longer declares `_activeClients`, `_runStructuredPipeline`,
  `_resolveActiveClients`, `_revectorizeTools`, `_listAllTools`,
  `_preparePipeline`, `_toEnglishForRag`, `_summarizeHistory`, nor the inline
  `pass` branch / RAG-orchestration block bodies — they live in the 5 new
  modules.
- `_runStreamingToolLoop`, the R5/R6 facades, `isReady`, `process`,
  `streamProcess`'s control flow, and `mergeSignals`/`createTimeoutSignal`
  remain in `agent.ts`. `pipeline/handlers/tool-loop.ts` is byte-unchanged.
- All public symbols still import from `agent.ts`; full suite GREEN; `lint:check`
  exit 0; 5 commits in order.
