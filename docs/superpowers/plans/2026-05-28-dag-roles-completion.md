# DAG Coordinator Role Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** active
**Spec:** `docs/superpowers/specs/2026-05-28-dag-roles-completion-design.md`
**Branch:** `epic/session-scoped-infrastructure`
**Date:** 2026-05-28

## Goal

Close two architectural gaps in the DAG coordinator:

1. Introduce `IFinalizer` as a typed DAG role producing the user-facing answer after interpretation completes (Passthrough / LLM / Template impls).
2. Introduce `IStateOracle` as a typed view over the existing oracle subagent, with an automatic adapter (`SubAgentStateOracle`) keeping current YAMLs working.
3. Extend top-level `llm:` into an optional named map (`llm.main`, `llm.planner`, `llm.finalizer`, …) with a backward-compatible normalizer and per-role lookup helper that chains through `pipeline.llm.main`.
4. Surface finalizer/oracle tokens via the existing `runRole`/`logRoleUsage` plumbing — new `LlmComponent` values land in `byComponent.finalizer` / `byComponent.oracle` under category `auxiliary`.

## Architecture

- **Contracts (`@mcp-abap-adt/llm-agent`):** new `IFinalizer` + `IStateOracle` interfaces; `LlmComponent` widened with `'finalizer' | 'oracle'`; `InterpretResult` gains `executionOrder: readonly string[]`.
- **Composition (`@mcp-abap-adt/llm-agent-libs`):** `PassthroughFinalizer`, `LlmFinalizer`, `TemplateFinalizer`, `SubAgentStateOracle` implementations + `CATEGORY_MAP` extension. `DagPlanInterpreter` now also returns `executedPlan` on success and records the topological `executionOrder`. `DagCoordinatorHandler` normalizes a default `PassthroughFinalizer`, invokes the finalizer through `runRole('finalizer', …)`, and the oracle through `IStateOracle.query` under `runRole('reviewer', …)`'s NeedInfo branch (logged as `'oracle'`).
- **Binary (`@mcp-abap-adt/llm-agent-server`):** `SmartServerConfig.llm` widened to an optional union; `normalizeLlmConfig` + `resolveLlmConfig` added; `resolveLlmConfig` accepts an optional `pipeline.llm.main` fallback so pipeline-only configs keep working; reviewer accepts both `reviewerLlm` and the deprecated `plannerLlm` alias (with warning); `coordinator.finalizer.{type, finalizerLlm?, systemPrompt?}` parsed and wired; the resolved oracle subagent is auto-wrapped in `SubAgentStateOracle`. A new `buildDagCoordinatorDeps` seam factors the wiring into a unit-testable helper.
- **Tests:** unit tests per impl + handler integration test + interpreter regression + config normalization/lookup/alias tests + a seam test against `buildDagCoordinatorDeps` exercising the default/LLM/template/oracle-wrapped/no-coordinator cases.

## Tech Stack

- TypeScript strict, ESM only (`.js` import suffixes).
- Biome (2 spaces, single quotes, semicolons).
- `npx tsx --test` per-package test runner.
- Conventional Commits, `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.

## File Structure

### Create

| Path | Responsibility |
|---|---|
| `packages/llm-agent/src/interfaces/finalizer.ts` | `FinalizerInput`, `FinalizerResult`, `IFinalizer`. |
| `packages/llm-agent/src/interfaces/state-oracle.ts` | `StateOracleInput`, `StateOracleResult`, `IStateOracle`. |
| `packages/llm-agent-libs/src/coordinator/dag/passthrough-finalizer.ts` | Returns `input.interpreterOutput` verbatim; no LLM. |
| `packages/llm-agent-libs/src/coordinator/dag/llm-finalizer.ts` | Wraps inner `ILlm` with `FINALIZER_SYSTEM`, no tools; renders trace into user prompt. |
| `packages/llm-agent-libs/src/coordinator/dag/template-finalizer.ts` | Deterministic markdown join over `executionTrace`. |
| `packages/llm-agent-libs/src/coordinator/dag/subagent-state-oracle.ts` | Adapter wrapping a raw `ISubAgent`; returns `usage: undefined` (double-count contract). |
| `packages/llm-agent-libs/src/coordinator/dag/__tests__/passthrough-finalizer.test.ts` | Multi-terminal verbatim check. |
| `packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-finalizer.test.ts` | No-tools call + usage + trace rendering. |
| `packages/llm-agent-libs/src/coordinator/dag/__tests__/template-finalizer.test.ts` | Deterministic markdown shape. |
| `packages/llm-agent-libs/src/coordinator/dag/__tests__/subagent-state-oracle.test.ts` | Maps `query→task`, `output→answer`; usage undefined. |
| `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-finalizer.test.ts` | Handler invokes finalizer with `executedPlan`/`executionOrder`. |
| `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-oracle.test.ts` | NeedInfo path calls `stateOracle.query` (not `.run`). |
| `packages/llm-agent-server/src/smart-agent/__tests__/llm-map-normalize.test.ts` | Normalizer + lookup (incl. pipeline fallback) + reviewer alias + finalizer wiring (incl. pipeline-fallback). |
| `packages/llm-agent-server/src/smart-agent/build-dag-coordinator-deps.ts` | Extracted seam: builds the `withDagCoordinator` deps record from resolved LLM map, pipeline fallback, registry, finalizer YAML, reviewer YAML, oracle name. |
| `packages/llm-agent-server/src/smart-agent/__tests__/build-dag-coordinator-deps.test.ts` | Seam test: default finalizer, LLM finalizer, template finalizer, oracle wrapped, no-coordinator. |

### Modify

| Path | Change |
|---|---|
| `packages/llm-agent/src/interfaces/request-logger.ts` | `LlmComponent` += `'finalizer' \| 'oracle'`. |
| `packages/llm-agent/src/interfaces/interpreter.ts` | `InterpretResult` += `executionOrder: readonly string[]`. |
| `packages/llm-agent/src/index.ts` | Re-export `IFinalizer`, `IStateOracle` types. |
| `packages/llm-agent-libs/src/logger/default-request-logger.ts` | `CATEGORY_MAP` += `finalizer: 'auxiliary'`, `oracle: 'auxiliary'`. |
| `packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts` | New test asserting `finalizer` and `oracle` aggregate into the `auxiliary` category. |
| `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts` | Record `executionOrder`; return it (and `executedPlan`) on BOTH success and failure paths. |
| `packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts` | New regression: success returns `executedPlan` + topological `executionOrder` after splice. |
| `packages/llm-agent-libs/src/coordinator/dag/index.ts` | Export the four new impls. |
| `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` | Add `finalizer?: IFinalizer`; normalize default; change `stateOracle` type to `IStateOracle \| undefined`; invoke finalizer via `runRole('finalizer', …)`; rewrite NeedInfo branch to `stateOracle.query(…)` logged as `'oracle'`. |
| `packages/llm-agent-server/src/smart-agent/config.ts` | Widen `SmartServerConfig.llm`; add `normalizeLlmConfig`, `resolveLlmConfig` (with pipeline fallback), `resolveReviewerLlmName`, `buildFinalizer` (with pipeline fallback); accept `reviewerLlm` alongside deprecated `plannerLlm` in reviewer block; parse `coordinator.finalizer.*`. |
| `packages/llm-agent-server/src/smart-agent/smart-server.ts` | Route every `this.cfg.llm.*` read through `resolveLlmConfig(map, name, pipeline?.llm?.main)`; extract DAG-deps assembly into `buildDagCoordinatorDeps`; auto-wrap stateOracle in `SubAgentStateOracle`. |

## Tasks

> All tasks use TDD: write failing test → run to fail → implement → run to pass → commit. Run tests with `npx tsx --test <path>` from the package root.

---

### Task 1 — `LlmComponent` widening + CATEGORY_MAP

- [ ] **1a. Write failing test.** Append to `packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts`:

```ts
test('finalizer and oracle components aggregate under the auxiliary category', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r');
  log.logLlmCall(call('finalizer', 11, 'r'));
  log.logLlmCall(call('oracle', 22, 'r'));
  const s = log.getSummary('r');
  assert.equal(s.byComponent['finalizer'].totalTokens, 11);
  assert.equal(s.byComponent['oracle'].totalTokens, 22);
  assert.equal(s.byCategory['auxiliary'].totalTokens, 33);
});
```

Run from `packages/llm-agent-libs`:

```bash
npx tsx --test src/logger/__tests__/session-request-logger.test.ts
```

Expect failure (component falls back to category `'request'`).

- [ ] **1b. Implement.**

Edit `packages/llm-agent/src/interfaces/request-logger.ts` — replace the `LlmComponent` union:

```ts
export type LlmComponent =
  | 'tool-loop'
  | 'classifier'
  | 'helper'
  | 'translate'
  | 'query-expander'
  | 'embedding'
  | 'planner'
  | 'reviewer'
  | 'finalizer'
  | 'oracle';
```

Edit `packages/llm-agent-libs/src/logger/default-request-logger.ts` — extend `CATEGORY_MAP`:

```ts
export const CATEGORY_MAP: Record<LlmComponent, TokenCategory> = {
  'tool-loop': 'request',
  classifier: 'auxiliary',
  translate: 'auxiliary',
  'query-expander': 'auxiliary',
  helper: 'auxiliary',
  embedding: 'initialization',
  planner: 'auxiliary',
  reviewer: 'auxiliary',
  finalizer: 'auxiliary',
  oracle: 'auxiliary',
};
```

- [ ] **1c. Build + test.**

```bash
npm --workspace @mcp-abap-adt/llm-agent run build
npm --workspace @mcp-abap-adt/llm-agent-libs run build
cd packages/llm-agent-libs && npx tsx --test src/logger/__tests__/session-request-logger.test.ts
```

- [ ] **1d. Commit.**

```bash
git add packages/llm-agent/src/interfaces/request-logger.ts \
        packages/llm-agent-libs/src/logger/default-request-logger.ts \
        packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts
git commit -m "feat(logger): add finalizer and oracle LlmComponent values

Both map to the 'auxiliary' category in CATEGORY_MAP so /v1/usage
buckets new DAG roles consistently with planner/reviewer/classifier.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2 — `IFinalizer` contract

- [ ] **2a. Write failing test.** Create `packages/llm-agent/src/interfaces/__tests__/finalizer.contract.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
} from '../finalizer.js';

test('IFinalizer contract: minimal happy-path shape compiles', async () => {
  const stub: IFinalizer = {
    name: 'stub',
    async finalize(input: FinalizerInput): Promise<FinalizerResult> {
      return { output: input.interpreterOutput };
    },
  };
  const res = await stub.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'verbatim',
    executionTrace: [{ nodeId: 'n1', goal: 'g', output: 'o1' }],
  });
  assert.equal(res.output, 'verbatim');
  assert.equal(stub.name, 'stub');
});
```

Run from `packages/llm-agent`:

```bash
npx tsx --test src/interfaces/__tests__/finalizer.contract.test.ts
```

Expect failure (`Cannot find module ../finalizer.js`).

- [ ] **2b. Implement.** Create `packages/llm-agent/src/interfaces/finalizer.ts`:

```ts
import type { ContextPath } from './context-path.js';
import type { LlmUsage } from './types.js';

export interface FinalizerInput {
  prompt: string;
  objective: string;
  ancestorContext?: ContextPath;
  interpreterOutput: string;
  executionTrace: ReadonlyArray<{
    nodeId: string;
    goal: string;
    output: string;
  }>;
  sessionId?: string;
  signal?: AbortSignal;
  trace?: { traceId: string };
}

export interface FinalizerResult {
  output: string;
  usage?: LlmUsage;
}

export interface IFinalizer {
  readonly name: string;
  readonly model?: string;
  finalize(input: FinalizerInput): Promise<FinalizerResult>;
}
```

Edit `packages/llm-agent/src/index.ts` — add (alongside existing interface re-exports):

```ts
export type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
} from './interfaces/finalizer.js';
```

- [ ] **2c. Build + test.**

```bash
npm --workspace @mcp-abap-adt/llm-agent run build
cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/finalizer.contract.test.ts
```

- [ ] **2d. Commit.**

```bash
git add packages/llm-agent/src/interfaces/finalizer.ts \
        packages/llm-agent/src/interfaces/__tests__/finalizer.contract.test.ts \
        packages/llm-agent/src/index.ts
git commit -m "feat(contracts): add IFinalizer interface

Typed DAG role that produces the user-facing answer after the
interpreter completes. FinalizerInput carries the original prompt,
plan objective, ancestorContext, the interpreter's joined output,
and an execution-ordered trace of node {id, goal, output}.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3 — `PassthroughFinalizer`

- [ ] **3a. Write failing test.** Create `packages/llm-agent-libs/src/coordinator/dag/__tests__/passthrough-finalizer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassthroughFinalizer } from '../passthrough-finalizer.js';

test('PassthroughFinalizer returns interpreterOutput verbatim (multi-terminal DAG)', async () => {
  const f = new PassthroughFinalizer();
  const joined = 'leaf-A output\n\nleaf-B output\n\nleaf-C output';
  const res = await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: joined,
    executionTrace: [
      { nodeId: 'a', goal: 'ga', output: 'leaf-A output' },
      { nodeId: 'b', goal: 'gb', output: 'leaf-B output' },
      { nodeId: 'c', goal: 'gc', output: 'leaf-C output' },
    ],
  });
  assert.equal(res.output, joined);
  assert.equal(res.usage, undefined);
  assert.equal(f.name, 'passthrough');
});
```

Run from `packages/llm-agent-libs`:

```bash
npx tsx --test src/coordinator/dag/__tests__/passthrough-finalizer.test.ts
```

Expect failure (module missing).

- [ ] **3b. Implement.** Create `packages/llm-agent-libs/src/coordinator/dag/passthrough-finalizer.ts`:

```ts
import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
} from '@mcp-abap-adt/llm-agent';

/**
 * Default finalizer. Returns the interpreter's already-joined output
 * verbatim — exactly what the DAG coordinator yielded before IFinalizer
 * was introduced. No LLM call; no usage attributed.
 */
export class PassthroughFinalizer implements IFinalizer {
  readonly name = 'passthrough';

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    return { output: input.interpreterOutput };
  }
}
```

- [ ] **3c. Test.**

```bash
cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/passthrough-finalizer.test.ts
```

- [ ] **3d. Commit.**

```bash
git add packages/llm-agent-libs/src/coordinator/dag/passthrough-finalizer.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/passthrough-finalizer.test.ts
git commit -m "feat(dag): add PassthroughFinalizer (default, no-LLM)

Returns interpreterOutput verbatim. Preserves the pre-IFinalizer DAG
coordinator behaviour so direct consumers that don't configure a
finalizer see no change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4 — `LlmFinalizer`

- [ ] **4a. Write failing test.** Create `packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-finalizer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  LlmCallOptions,
  Message,
  Tool,
} from '@mcp-abap-adt/llm-agent';
import { LlmFinalizer, FINALIZER_SYSTEM } from '../llm-finalizer.js';

function stubLlm(): {
  llm: ILlm;
  calls: Array<{ messages: Message[]; tools: Tool[] }>;
} {
  const calls: Array<{ messages: Message[]; tools: Tool[] }> = [];
  const llm: ILlm = {
    name: 'stub',
    async chat(messages: Message[], tools: Tool[], _opts?: LlmCallOptions) {
      calls.push({ messages, tools });
      return {
        ok: true as const,
        value: {
          content: 'SYNTH',
          usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
        },
      };
    },
  };
  return { llm, calls };
}

test('LlmFinalizer calls inner ILlm with FINALIZER_SYSTEM and no tools', async () => {
  const { llm, calls } = stubLlm();
  const f = new LlmFinalizer(llm);
  const res = await f.finalize({
    prompt: 'Build report',
    objective: 'compose final answer',
    interpreterOutput: 'IGNORED',
    executionTrace: [
      { nodeId: 'n1', goal: 'analyse', output: 'A' },
      { nodeId: 'n2', goal: 'summarise', output: 'B' },
    ],
  });
  assert.equal(res.output, 'SYNTH');
  assert.deepEqual(res.usage, {
    promptTokens: 3,
    completionTokens: 5,
    totalTokens: 8,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, []);
  assert.equal(calls[0].messages[0].role, 'system');
  assert.equal(calls[0].messages[0].content, FINALIZER_SYSTEM);
  const user = calls[0].messages[1].content as string;
  assert.ok(user.includes('Build report'));
  assert.ok(user.includes('compose final answer'));
  assert.ok(user.includes('n1'));
  assert.ok(user.includes('analyse'));
  assert.ok(user.includes('A'));
  assert.ok(user.includes('n2'));
  assert.ok(user.includes('B'));
});

test('LlmFinalizer honours a custom systemPrompt override', async () => {
  const { llm, calls } = stubLlm();
  const f = new LlmFinalizer(llm, { systemPrompt: 'CUSTOM' });
  await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: '',
    executionTrace: [],
  });
  assert.equal(calls[0].messages[0].content, 'CUSTOM');
});
```

Run from `packages/llm-agent-libs`:

```bash
npx tsx --test src/coordinator/dag/__tests__/llm-finalizer.test.ts
```

Expect failure (module missing).

- [ ] **4b. Implement.** Create `packages/llm-agent-libs/src/coordinator/dag/llm-finalizer.ts`:

```ts
import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
  ILlm,
  Message,
} from '@mcp-abap-adt/llm-agent';

export const FINALIZER_SYSTEM =
  'You synthesize the final user-facing answer for a DAG-coordinated task. ' +
  'You will receive: (1) the user prompt, (2) the plan objective, (3) an ' +
  'ordered execution trace of completed DAG nodes (each with its goal and ' +
  'output). Produce the answer using ONLY the trace outputs. Do NOT propose ' +
  'new data collection. Do NOT include the trace structure in your reply ' +
  "unless the user asked for it. Address every part of the user's prompt.";

export interface LlmFinalizerOptions {
  systemPrompt?: string;
  name?: string;
  model?: string;
}

function renderUserMessage(input: FinalizerInput): string {
  const lines: string[] = [];
  lines.push(`# User prompt`, input.prompt, '');
  lines.push(`# Plan objective`, input.objective, '');
  if (input.ancestorContext) {
    const ac = input.ancestorContext;
    if (ac.clarifications.length > 0) {
      lines.push('# Clarifications');
      for (const c of ac.clarifications) {
        lines.push(`- Q: ${c.question}`);
        lines.push(`  A: ${c.answer}`);
      }
      lines.push('');
    }
    if (ac.oracleObservations.length > 0) {
      lines.push('# Oracle observations');
      for (const o of ac.oracleObservations) {
        lines.push(`- Q: ${o.query}`);
        lines.push(`  A: ${o.answer}`);
      }
      lines.push('');
    }
  }
  lines.push('# Execution trace');
  for (const t of input.executionTrace) {
    lines.push(`## Node ${t.nodeId} — ${t.goal}`);
    lines.push(t.output);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Synthesizes the final answer via a single LLM call. NO tools are wired:
 * the LLM cannot escape into another tool-loop. The user message is a
 * deterministic rendering of prompt + objective + ancestorContext + trace.
 */
export class LlmFinalizer implements IFinalizer {
  readonly name: string;
  readonly model?: string;
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: ILlm,
    opts: LlmFinalizerOptions = {},
  ) {
    this.name = opts.name ?? 'llm-finalizer';
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? FINALIZER_SYSTEM;
  }

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: renderUserMessage(input) },
    ];
    const res = await this.llm.chat(messages, [], {
      signal: input.signal,
      sessionId: input.sessionId,
    });
    if (!res.ok) throw res.error;
    return { output: res.value.content, usage: res.value.usage };
  }
}
```

- [ ] **4c. Test.**

```bash
cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/llm-finalizer.test.ts
```

- [ ] **4d. Commit.**

```bash
git add packages/llm-agent-libs/src/coordinator/dag/llm-finalizer.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-finalizer.test.ts
git commit -m "feat(dag): add LlmFinalizer (one LLM call, no tools)

Calls the inner ILlm with FINALIZER_SYSTEM and a deterministic user
message rendering the prompt, objective, ancestorContext and
execution trace. Tools array is always empty — the finalizer cannot
escape into another tool-loop.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 — `TemplateFinalizer`

- [ ] **5a. Write failing test.** Create `packages/llm-agent-libs/src/coordinator/dag/__tests__/template-finalizer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TemplateFinalizer } from '../template-finalizer.js';

test('TemplateFinalizer joins trace into deterministic markdown', async () => {
  const f = new TemplateFinalizer();
  const res = await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'IGNORED',
    executionTrace: [
      { nodeId: 'n1', goal: 'analyse', output: 'A body' },
      { nodeId: 'n2', goal: 'summarise', output: 'B body' },
    ],
  });
  assert.equal(
    res.output,
    '# Node n1 — analyse\nA body\n\n# Node n2 — summarise\nB body\n\n',
  );
  assert.equal(res.usage, undefined);
  assert.equal(f.name, 'template');
});
```

Run:

```bash
cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/template-finalizer.test.ts
```

Expect failure.

- [ ] **5b. Implement.** Create `packages/llm-agent-libs/src/coordinator/dag/template-finalizer.ts`:

```ts
import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
} from '@mcp-abap-adt/llm-agent';

/**
 * Deterministic markdown join over the execution trace. No LLM. Useful
 * when the plan is already shaped per-section and the answer is just
 * the concatenation of the section outputs.
 */
export class TemplateFinalizer implements IFinalizer {
  readonly name = 'template';

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    let out = '';
    for (const t of input.executionTrace) {
      out += `# Node ${t.nodeId} — ${t.goal}\n${t.output}\n\n`;
    }
    return { output: out };
  }
}
```

- [ ] **5c. Test + commit.**

```bash
cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/template-finalizer.test.ts
git add packages/llm-agent-libs/src/coordinator/dag/template-finalizer.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/template-finalizer.test.ts
git commit -m "feat(dag): add TemplateFinalizer (deterministic markdown join)

Concatenates the execution trace as '# Node {id} — {goal}\\n{output}\\n\\n'.
No LLM call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6 — `IStateOracle` contract

- [ ] **6a. Write failing test.** Create `packages/llm-agent/src/interfaces/__tests__/state-oracle.contract.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IStateOracle,
  StateOracleInput,
  StateOracleResult,
} from '../state-oracle.js';

test('IStateOracle contract: minimal shape compiles and answers', async () => {
  const stub: IStateOracle = {
    name: 'stub',
    async query(input: StateOracleInput): Promise<StateOracleResult> {
      return { answer: `you asked: ${input.query}` };
    },
  };
  const res = await stub.query({ query: 'who am i' });
  assert.equal(res.answer, 'you asked: who am i');
  assert.equal(res.usage, undefined);
});
```

Run from `packages/llm-agent`:

```bash
npx tsx --test src/interfaces/__tests__/state-oracle.contract.test.ts
```

Expect failure (module missing).

- [ ] **6b. Implement.** Create `packages/llm-agent/src/interfaces/state-oracle.ts`:

```ts
import type { LlmUsage } from './types.js';

export interface StateOracleInput {
  query: string;
  sessionId?: string;
  signal?: AbortSignal;
  trace?: { traceId: string };
  sessionLogger?: { logStep(name: string, data: unknown): void };
}

export interface StateOracleResult {
  answer: string;
  usage?: LlmUsage;
}

export interface IStateOracle {
  readonly name: string;
  readonly model?: string;
  query(input: StateOracleInput): Promise<StateOracleResult>;
}
```

Edit `packages/llm-agent/src/index.ts` — add:

```ts
export type {
  IStateOracle,
  StateOracleInput,
  StateOracleResult,
} from './interfaces/state-oracle.js';
```

- [ ] **6c. Build + test.**

```bash
npm --workspace @mcp-abap-adt/llm-agent run build
cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/state-oracle.contract.test.ts
```

- [ ] **6d. Commit.**

```bash
git add packages/llm-agent/src/interfaces/state-oracle.ts \
        packages/llm-agent/src/interfaces/__tests__/state-oracle.contract.test.ts \
        packages/llm-agent/src/index.ts
git commit -m "feat(contracts): add IStateOracle interface

Typed view over the previously-untyped 'inspection-only subagent'
role used by NeedInfoSignal round-trips. Domain-neutral
{query, sessionId?, signal?, trace?, sessionLogger?} input;
{answer, usage?} output.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7 — `SubAgentStateOracle` adapter

- [ ] **7a. Write failing test.** Create `packages/llm-agent-libs/src/coordinator/dag/__tests__/subagent-state-oracle.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ISubAgent, ISubAgentInput } from '@mcp-abap-adt/llm-agent';
import { SubAgentStateOracle } from '../subagent-state-oracle.js';

function stubSubagent(): { sa: ISubAgent; lastInput: { v?: ISubAgentInput } } {
  const lastInput: { v?: ISubAgentInput } = {};
  const sa: ISubAgent = {
    name: 'inspector',
    description: 'reads real state',
    capabilities: { contextPolicy: 'optional' },
    async run(input: ISubAgentInput) {
      lastInput.v = input;
      return {
        output: `answer: ${input.task}`,
        usage: { promptTokens: 9, completionTokens: 1, totalTokens: 10 },
      };
    },
  };
  return { sa, lastInput };
}

test('SubAgentStateOracle maps query→task, output→answer', async () => {
  const { sa, lastInput } = stubSubagent();
  const oracle = new SubAgentStateOracle(sa);
  const res = await oracle.query({
    query: 'is the file deleted',
    sessionId: 's1',
    trace: { traceId: 't1' },
  });
  assert.equal(res.answer, 'answer: is the file deleted');
  assert.equal(lastInput.v?.task, 'is the file deleted');
  assert.equal(lastInput.v?.sessionId, 's1');
  assert.equal(lastInput.v?.trace?.traceId, 't1');
  assert.equal(oracle.name, 'inspector');
});

test('SubAgentStateOracle returns usage:undefined even if inner subagent returns usage (double-count contract)', async () => {
  const { sa } = stubSubagent();
  const oracle = new SubAgentStateOracle(sa);
  const res = await oracle.query({ query: 'q' });
  assert.equal(res.usage, undefined);
});
```

Run:

```bash
cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/subagent-state-oracle.test.ts
```

Expect failure.

- [ ] **7b. Implement.** Create `packages/llm-agent-libs/src/coordinator/dag/subagent-state-oracle.ts`:

```ts
import type {
  IStateOracle,
  ISubAgent,
  StateOracleInput,
  StateOracleResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Adapter wrapping a raw ISubAgent as an IStateOracle. The wrapped
 * subagent runs a full pipeline whose LLM activity is logged by its
 * own handlers under their own component labels (`tool-loop`,
 * `classifier`, …) via the SHARED session requestLogger keyed on the
 * forwarded traceId. To avoid double-counting, this adapter
 * intentionally returns `usage: undefined`; the handler's
 * `logRoleUsage('oracle', …)` is therefore a no-op for subagent-backed
 * oracles. A pure-LLM IStateOracle implementation that bypasses
 * pipeline logging would populate `usage` normally.
 */
export class SubAgentStateOracle implements IStateOracle {
  constructor(private readonly inner: ISubAgent) {}

  get name(): string {
    return this.inner.name;
  }

  async query(input: StateOracleInput): Promise<StateOracleResult> {
    const res = await this.inner.run({
      task: input.query,
      sessionId: input.sessionId,
      signal: input.signal,
      trace: input.trace,
      sessionLogger: input.sessionLogger,
    });
    return { answer: res.output, usage: undefined };
  }
}
```

- [ ] **7c. Test + commit.**

```bash
cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/subagent-state-oracle.test.ts
git add packages/llm-agent-libs/src/coordinator/dag/subagent-state-oracle.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/subagent-state-oracle.test.ts
git commit -m "feat(dag): add SubAgentStateOracle adapter

Wraps a raw ISubAgent as IStateOracle. Forwards trace + sessionLogger
so the inner pipeline self-attributes by traceId, and returns
usage:undefined to honour the double-count contract (the wrapped
pipeline already logs to the same shared session requestLogger under
its own component labels).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8 — Interpreter `executionOrder` + `executedPlan` on success

- [ ] **8a. Write failing test.** Append to `packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts`. NOTE: every `DagPlan` literal MUST include `createdAt: 0` because `packages/llm-agent/src/interfaces/dag-plan.ts:18` makes it required:

```ts
test('returns executedPlan + topological executionOrder on success after splice', async () => {
  // Plan: a → b ; replan on b inserts {b1 ← a, b2 ← b1}
  const replanned = {
    objective: 'patched',
    nodes: [
      { id: 'b1', goal: 'gb1', dependsOn: ['a'] },
      { id: 'b2', goal: 'gb2', dependsOn: ['b1'] },
    ],
    createdAt: 0,
  };
  let bAttempts = 0;
  const worker = {
    name: 'w',
    description: 'd',
    capabilities: { contextPolicy: 'optional' as const },
    async run(input: { task: string }) {
      if (input.task.includes("'b'") && bAttempts === 0) {
        bAttempts++;
        throw new Error('boom');
      }
      return { output: `out:${input.task.slice(0, 20)}` };
    },
  };
  const interp = new DagPlanInterpreter();
  const res = await interp.interpret(
    {
      objective: 'orig',
      nodes: [
        { id: 'a', goal: 'ga' },
        { id: 'b', goal: 'gb', dependsOn: ['a'] },
      ],
      createdAt: 0,
    },
    {
      inputText: 'x',
      workers: new Map([['w', worker]]),
      sessionId: 's',
      errorStrategy: {
        maxReplans: 2,
        async onNodeFailure() {
          return { action: 'replan' as const, subPlan: replanned };
        },
      },
    },
  );
  assert.equal(res.ok, true);
  assert.ok(res.executedPlan, 'executedPlan must be populated on success');
  const ids = (res.executedPlan?.nodes ?? []).map((n) => n.id).sort();
  assert.deepEqual(ids, ['a', 'b1', 'b2']);
  // executionOrder is topologically valid: every id appears after all its dependsOn
  const order = res.executionOrder ?? [];
  const pos = new Map(order.map((id, i) => [id, i]));
  const byId = new Map(res.executedPlan?.nodes?.map((n) => [n.id, n]) ?? []);
  for (const id of order) {
    for (const d of byId.get(id)?.dependsOn ?? []) {
      assert.ok(
        (pos.get(d) ?? -1) < (pos.get(id) ?? -1),
        `dep ${d} must precede ${id} in executionOrder`,
      );
    }
  }
  assert.equal(order.includes('a'), true);
  assert.equal(order.includes('b1'), true);
  assert.equal(order.includes('b2'), true);
});

test('returns executionOrder on failure path too', async () => {
  const failWorker = {
    name: 'w',
    description: 'd',
    capabilities: { contextPolicy: 'optional' as const },
    async run() {
      throw new Error('nope');
    },
  };
  const interp = new DagPlanInterpreter();
  const res = await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'ga' }], createdAt: 0 },
    {
      inputText: 'x',
      workers: new Map([['w', failWorker]]),
      sessionId: 's',
      errorStrategy: {
        async onNodeFailure() {
          return { action: 'abort' as const };
        },
      },
    },
  );
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.executionOrder));
});
```

Run:

```bash
cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts
```

Expect the new tests to fail.

- [ ] **8b. Implement.**

Edit `packages/llm-agent/src/interfaces/interpreter.ts` — extend `InterpretResult`:

```ts
export interface InterpretResult {
  nodeResults: Record<string, NodeResult>;
  ok: boolean;
  error?: string;
  output: string;
  /** Set when ok === false: the node whose failure stopped the run (first
   *  plan-node-order node with status 'failed'). */
  failedNodeId?: string;
  /** The final plan after any in-run local splices. Populated on BOTH
   *  success and failure paths. */
  executedPlan?: DagPlan;
  /** Topological execution order of node ids, in the actual order the
   *  interpreter ran them. Authoritative — `executedPlan.nodes[]` is NOT
   *  topological after a splice. */
  executionOrder: readonly string[];
}
```

Edit `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`:

1. Add `const executionOrder: string[] = [];` near the top of `interpret(...)` (next to `const done = new Set<string>();`).
2. Inside the loop that records successes, append the id:

```ts
      // Record successes first, then process failures in plan-node order.
      for (const o of outcomes) {
        if (o.kind !== 'done') continue;
        results[o.node.id] = {
          nodeId: o.node.id,
          output: o.output,
          status: 'done',
          durationMs: o.durationMs,
        };
        done.add(o.node.id);
        executionOrder.push(o.node.id);
      }
```

3. Update the failure-path return to include `executionOrder`:

```ts
      return {
        nodeResults: results,
        ok: false,
        error: firstFailed
          ? `node '${firstFailed.id}' failed: ${results[firstFailed.id].error ?? 'unknown'}`
          : 'plan did not complete',
        output: '',
        failedNodeId: firstFailed?.id,
        executedPlan: currentPlan,
        executionOrder,
      };
```

4. Replace the success return:

```ts
    return {
      nodeResults: results,
      ok: true,
      output,
      executedPlan: currentPlan,
      executionOrder,
    };
```

- [ ] **8c. Build + test.**

```bash
npm --workspace @mcp-abap-adt/llm-agent run build
npm --workspace @mcp-abap-adt/llm-agent-libs run build
cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts
```

- [ ] **8d. Commit.**

```bash
git add packages/llm-agent/src/interfaces/interpreter.ts \
        packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts
git commit -m "feat(dag): expose executedPlan + executionOrder from interpreter

(a) Success path now returns executedPlan: currentPlan so recovery
    / replan splices are visible to downstream consumers (the
    finalizer in particular).
(b) New executionOrder field records the actual topological run
    order of node ids — plan.nodes[] is not topological after a
    splice (spliceSubPlan returns [...rest, ...sub]).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9 — `DagCoordinatorHandler` integration

- [ ] **9a. Write failing test.** Create `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-finalizer.test.ts`. Every `DagPlan` literal includes `createdAt: 0` to satisfy the required field:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DagPlan,
  IFinalizer,
  IInterpreter,
  InterpretResult,
  IPlanner,
  ISubAgent,
  IStateOracle,
} from '@mcp-abap-adt/llm-agent';
import { NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

function plan(): DagPlan {
  return {
    objective: 'plan-obj',
    nodes: [
      { id: 'a', goal: 'ga' },
      { id: 'b', goal: 'gb', dependsOn: ['a'] },
    ],
    createdAt: 0,
  };
}

const planner: IPlanner = {
  name: 'p',
  async plan() {
    return { plan: plan() };
  },
};

const worker: ISubAgent = {
  name: 'w',
  description: 'd',
  capabilities: { contextPolicy: 'optional' },
  async run(input) {
    return { output: `OUT(${input.task.slice(0, 4)})` };
  },
};

const interpreter: IInterpreter<DagPlan, InterpretResult> = {
  name: 'i',
  async interpret(p) {
    return {
      ok: true,
      nodeResults: {
        a: { nodeId: 'a', output: 'A-OUT', status: 'done', durationMs: 1 },
        b: { nodeId: 'b', output: 'B-OUT', status: 'done', durationMs: 1 },
      },
      output: 'A-OUT\n\nB-OUT',
      executedPlan: p,
      executionOrder: ['a', 'b'],
    };
  },
};

function makeCtx() {
  const yields: any[] = [];
  const logger = new SessionRequestLogger();
  logger.startRequest('t1');
  return {
    yields,
    ctx: {
      inputText: 'do thing',
      sessionId: 's1',
      history: [],
      requestLogger: logger,
      yield(chunk: unknown) {
        yields.push(chunk);
      },
      options: { trace: { traceId: 't1' } },
    } as never,
  };
}

test('handler invokes finalizer with executionOrder-derived trace and yields finalizer output', async () => {
  let captured: { prompt?: string; trace?: unknown; objective?: string } = {};
  const finalizer: IFinalizer = {
    name: 'capture',
    async finalize(input) {
      captured = {
        prompt: input.prompt,
        trace: input.executionTrace,
        objective: input.objective,
      };
      return {
        output: 'FINAL',
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      };
    },
  };
  const h = new DagCoordinatorHandler({
    planner,
    interpreter,
    workers: new Map([['w', worker]]),
    finalizer,
  });
  const { ctx, yields } = makeCtx();
  await h.execute(ctx, {}, {} as never);
  assert.equal(captured.prompt, 'do thing');
  assert.equal(captured.objective, 'plan-obj');
  assert.deepEqual(captured.trace, [
    { nodeId: 'a', goal: 'ga', output: 'A-OUT' },
    { nodeId: 'b', goal: 'gb', output: 'B-OUT' },
  ]);
  const contentYield = yields.find(
    (y) => y.value?.content && y.value.finishReason !== 'stop',
  );
  assert.equal(contentYield.value.content, 'FINAL');
});

test('handler defaults to PassthroughFinalizer when deps.finalizer is omitted', async () => {
  const h = new DagCoordinatorHandler({
    planner,
    interpreter,
    workers: new Map([['w', worker]]),
  });
  const { ctx, yields } = makeCtx();
  await h.execute(ctx, {}, {} as never);
  const contentYield = yields.find(
    (y) => y.value?.content && y.value.finishReason !== 'stop',
  );
  assert.equal(contentYield.value.content, 'A-OUT\n\nB-OUT');
});
```

Create `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-oracle.test.ts`. Every `DagPlan` literal includes `createdAt: 0`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DagPlan,
  IInterpreter,
  InterpretResult,
  IPlanner,
  ISubAgent,
  IStateOracle,
} from '@mcp-abap-adt/llm-agent';
import { NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

const worker: ISubAgent = {
  name: 'w',
  description: 'd',
  capabilities: { contextPolicy: 'optional' },
  async run() {
    return { output: 'X' };
  },
};

const interpreter: IInterpreter<DagPlan, InterpretResult> = {
  name: 'i',
  async interpret(p) {
    return {
      ok: true,
      nodeResults: {
        n: { nodeId: 'n', output: 'X', status: 'done', durationMs: 1 },
      },
      output: 'X',
      executedPlan: p,
      executionOrder: ['n'],
    };
  },
};

test('handler routes NeedInfoSignal through IStateOracle.query (not ISubAgent.run)', async () => {
  let plannerCalls = 0;
  const planner: IPlanner = {
    name: 'p',
    async plan() {
      plannerCalls++;
      if (plannerCalls === 1) {
        throw new NeedInfoSignal('is X true?');
      }
      return {
        plan: {
          objective: 'o',
          nodes: [{ id: 'n', goal: 'g' }],
          createdAt: 0,
        },
      };
    },
  };
  const oracleCalls: string[] = [];
  const oracle: IStateOracle = {
    name: 'oracle',
    async query(input) {
      oracleCalls.push(input.query);
      return { answer: 'yes' };
    },
  };
  const h = new DagCoordinatorHandler({
    planner,
    interpreter,
    workers: new Map([['w', worker]]),
    stateOracle: oracle,
  });
  const logger = new SessionRequestLogger();
  logger.startRequest('t1');
  const yields: any[] = [];
  const ctx = {
    inputText: 'p',
    sessionId: 's',
    history: [],
    requestLogger: logger,
    yield: (c: unknown) => yields.push(c),
    options: { trace: { traceId: 't1' } },
  } as never;
  await h.execute(ctx, {}, {} as never);
  assert.deepEqual(oracleCalls, ['is X true?']);
  assert.equal(plannerCalls, 2);
});
```

Run:

```bash
cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/dag-coordinator-finalizer.test.ts src/pipeline/handlers/__tests__/dag-coordinator-oracle.test.ts
```

Expect failures.

- [ ] **9b. Implement.** Edit `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`:

1. Update the imports at the top:

```ts
import type {
  ClarifySignal as ClarifySignalType,
  ContextPath,
  DagPlan,
  ExecutionReviewResult,
  IActivationStrategy,
  IErrorStrategy,
  IFinalizer,
  IInterpreter,
  InterpretResult,
  IPlanner,
  IReviewStrategy,
  IStateOracle,
  ISubAgent,
  LlmComponent,
  LlmUsage,
  PlannerResult,
  ReviewResult,
} from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import { AbortErrorStrategy } from '../../coordinator/index.js';
import { PassthroughFinalizer } from '../../coordinator/dag/passthrough-finalizer.js';
import { summaryToUsage } from '../../logger/session-request-logger.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
```

2. Update `DagCoordinatorHandlerDeps`:

```ts
export interface DagCoordinatorHandlerDeps {
  planner: IPlanner;
  interpreter: IInterpreter<DagPlan, InterpretResult>;
  workers: ReadonlyMap<string, ISubAgent>;
  activation?: IActivationStrategy;
  reviewer?: IReviewStrategy;
  errorStrategy?: IErrorStrategy;
  /** Optional inspection-only state oracle answering "real state" queries
   *  (git / FS / ABAP) via NeedInfoSignal round-trips. Wrapped by the
   *  server from a raw ISubAgent automatically; never a DAG worker. */
  stateOracle?: IStateOracle;
  /** Optional response synthesizer. Defaults to PassthroughFinalizer
   *  (which returns interpreter.output verbatim), so omitting it
   *  preserves the legacy DAG coordinator behaviour. */
  finalizer?: IFinalizer;
  maxRoundTrips?: number;
}
```

3. Add a normalized `finalizer` field in the class:

```ts
export class DagCoordinatorHandler implements IStageHandler {
  private readonly finalizer: IFinalizer;

  constructor(private readonly deps: DagCoordinatorHandlerDeps) {
    this.finalizer = deps.finalizer ?? new PassthroughFinalizer();
    for (const [name, w] of deps.workers) {
      if (w.capabilities?.contextPolicy === 'required') {
        throw new Error(
          `DagCoordinatorHandler: worker '${name}' has contextPolicy='required', ` +
            'but the DAG interpreter supplies node data via the composed task text, ' +
            "not the context field. Use a worker with contextPolicy 'optional' or 'forbidden'.",
        );
      }
    }
  }
```

4. Replace the `NeedInfoSignal` branch body inside `runRole` so it calls `stateOracle.query(...)` and logs as `'oracle'`:

```ts
          if (err instanceof NeedInfoSignal) {
            logRoleUsage(component, model, err.usage, Date.now() - start);
            if (!this.deps.stateOracle) {
              throw new OrchestratorError(
                `coordinator: role requested info but no stateOracle is configured: ${(err as NeedInfoSignal).query}`,
                'COORDINATOR_NEEDINFO_UNRESOLVED',
              );
            }
            if (++roundTrips > maxRoundTrips) {
              throw new OrchestratorError(
                'coordinator: round-trip budget exhausted',
                'COORDINATOR_BUDGET_EXHAUSTED',
              );
            }
            const oracleStart = Date.now();
            const ans = await this.deps.stateOracle.query({
              query: (err as NeedInfoSignal).query,
              sessionId: ctx.sessionId,
              signal: ctx.options?.signal,
              trace: ctx.options?.trace,
              sessionLogger: ctx.options?.sessionLogger,
            });
            logRoleUsage(
              'oracle',
              this.deps.stateOracle.model,
              ans.usage,
              Date.now() - oracleStart,
            );
            ancestorContext.oracleObservations.push({
              query: (err as NeedInfoSignal).query,
              answer: ans.answer,
            });
            continue;
          }
```

5. Replace the success branch (the `if (result.ok) { … }` block currently around line 307) with the finalizer invocation:

```ts
        if (result.ok) {
          ctx.options?.sessionLogger?.logStep('dag_coordinator_final', {
            nodeCount: plan.nodes.length,
            outputLength: result.output.length,
          });
          const executedPlan = result.executedPlan ?? plan;
          const nodeIndex = new Map(
            executedPlan.nodes?.map((n) => [n.id, n]) ?? [],
          );
          const executionTrace = (result.executionOrder ?? []).map((id) => ({
            nodeId: id,
            goal: nodeIndex.get(id)?.goal ?? '',
            output: result.nodeResults[id]?.output ?? '',
          }));
          const finalRes = await runRole(
            'finalizer',
            this.finalizer.model,
            () =>
              this.finalizer.finalize({
                prompt: ctx.inputText,
                objective: executedPlan.objective ?? ctx.inputText,
                ancestorContext,
                interpreterOutput: result.output,
                executionTrace,
                sessionId: ctx.sessionId,
                signal: ctx.options?.signal,
                trace: ctx.options?.trace,
              }),
          );
          if ('ended' in finalRes) return true;
          const finalText = finalRes.value.output;
          ctx.yield({ ok: true, value: { content: finalText } });
          const traceId = ctx.options?.trace?.traceId;
          const usage = traceId
            ? summaryToUsage(ctx.requestLogger.getSummary(traceId))
            : undefined;
          ctx.yield({
            ok: true,
            value: {
              content: '',
              finishReason: 'stop',
              ...(usage ? { usage } : {}),
            },
          });
          return true;
        }
```

- [ ] **9c. Build + test.**

```bash
npm --workspace @mcp-abap-adt/llm-agent-libs run build
cd packages/llm-agent-libs && npx tsx --test \
  src/pipeline/handlers/__tests__/dag-coordinator-finalizer.test.ts \
  src/pipeline/handlers/__tests__/dag-coordinator-oracle.test.ts \
  src/pipeline/handlers/__tests__/dag-coordinator.test.ts \
  src/pipeline/handlers/__tests__/dag-coordinator-role-usage.test.ts
```

All four must pass (the last two are existing regressions). If any existing test in those files constructs a `DagPlan` literal, audit it for the now-required `createdAt` and patch in this same commit.

- [ ] **9d. Commit.**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts \
        packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-finalizer.test.ts \
        packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-oracle.test.ts
git commit -m "feat(dag): wire IFinalizer and IStateOracle into DagCoordinatorHandler

- deps.finalizer is optional and defaults to PassthroughFinalizer
  (preserves the pre-IFinalizer DAG coordinator behaviour).
- After a successful interpret, the handler builds an executionTrace
  from result.executionOrder + result.executedPlan.nodes and runs the
  finalizer through runRole('finalizer', …) so its tokens land in
  /v1/usage.byComponent.finalizer.
- deps.stateOracle is now IStateOracle (was raw ISubAgent). The
  NeedInfoSignal branch calls stateOracle.query(...) and logs usage
  under the 'oracle' component (no-op when usage is undefined, as is
  the case for SubAgentStateOracle).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10 — `llm:` map normalizer + lookup (with pipeline fallback) + reviewer alias

- [ ] **10a. Write failing test.** Create `packages/llm-agent-server/src/smart-agent/__tests__/llm-map-normalize.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeLlmConfig,
  resolveLlmConfig,
  resolveReviewerLlmName,
} from '../config.js';

test('normalizeLlmConfig: undefined input returns undefined', () => {
  assert.equal(normalizeLlmConfig(undefined), undefined);
});

test('normalizeLlmConfig: flat shape is wrapped as { main: flat }', () => {
  const flat = { provider: 'deepseek', apiKey: 'k', model: 'm' } as never;
  const out = normalizeLlmConfig(flat);
  assert.ok(out);
  assert.equal(out?.main, flat);
});

test('normalizeLlmConfig: map without main throws', () => {
  assert.throws(
    () =>
      normalizeLlmConfig({
        planner: { provider: 'openai', apiKey: 'k' },
      } as never),
    /must include a 'main' key/,
  );
});

test('normalizeLlmConfig: map with main is returned as-is', () => {
  const map = {
    main: { provider: 'deepseek', apiKey: 'k' },
    planner: { provider: 'sap-ai-sdk', model: 'sonnet' },
  } as never;
  const out = normalizeLlmConfig(map);
  assert.equal(out, map);
});

test('resolveLlmConfig: undefined map + no fallback returns undefined', () => {
  assert.equal(resolveLlmConfig(undefined, 'planner'), undefined);
});

test('resolveLlmConfig: undefined map but pipeline fallback returns the fallback', () => {
  const fallback = { provider: 'deepseek', apiKey: 'k' } as never;
  assert.equal(resolveLlmConfig(undefined, 'planner', fallback), fallback);
});

test('resolveLlmConfig: omitted name resolves to main', () => {
  const map = { main: { provider: 'deepseek', apiKey: 'k' } } as never;
  assert.equal(resolveLlmConfig(map), map.main);
});

test("resolveLlmConfig: name='main' resolves to main", () => {
  const map = { main: { provider: 'deepseek', apiKey: 'k' } } as never;
  assert.equal(resolveLlmConfig(map, 'main'), map.main);
});

test('resolveLlmConfig: named key resolves to its config', () => {
  const map = {
    main: { provider: 'deepseek', apiKey: 'k' },
    planner: { provider: 'sap-ai-sdk', model: 's' },
  } as never;
  assert.equal(resolveLlmConfig(map, 'planner'), map.planner);
});

test('resolveLlmConfig: unknown name falls back to main', () => {
  const map = { main: { provider: 'deepseek', apiKey: 'k' } } as never;
  assert.equal(resolveLlmConfig(map, 'nope'), map.main);
});

test('resolveLlmConfig: map without the named key prefers main over pipeline fallback', () => {
  // The chain is: map[name] → map.main → fallback. If map.main exists,
  // pipeline fallback is NOT used.
  const map = { main: { provider: 'deepseek', apiKey: 'k' } } as never;
  const fallback = { provider: 'openai', apiKey: 'k' } as never;
  assert.equal(resolveLlmConfig(map, 'planner', fallback), map.main);
});

test('resolveReviewerLlmName: prefers reviewerLlm', () => {
  const warnings: string[] = [];
  const r = resolveReviewerLlmName(
    { reviewerLlm: 'planner', plannerLlm: 'main' } as never,
    (m) => warnings.push(m),
  );
  assert.equal(r, 'planner');
  assert.deepEqual(warnings, []);
});

test('resolveReviewerLlmName: accepts deprecated plannerLlm alias and warns', () => {
  const warnings: string[] = [];
  const r = resolveReviewerLlmName(
    { plannerLlm: 'planner' } as never,
    (m) => warnings.push(m),
  );
  assert.equal(r, 'planner');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plannerLlm.*deprecated/i);
});

test('resolveReviewerLlmName: empty block returns undefined', () => {
  assert.equal(resolveReviewerLlmName(undefined, () => {}), undefined);
  assert.equal(resolveReviewerLlmName({} as never, () => {}), undefined);
});
```

Run:

```bash
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/llm-map-normalize.test.ts
```

Expect failure (exports missing).

- [ ] **10b. Implement.** Edit `packages/llm-agent-server/src/smart-agent/config.ts`:

1. Add at the top of the file (after existing imports) — and add this exported types/functions block before the existing `YamlCoordinator` interface:

```ts
import type { SmartServerLlmConfig } from './smart-server.js';

export type LlmConfigMap = Record<string, SmartServerLlmConfig>;
export type NormalizedLlmMap = { main: SmartServerLlmConfig } & LlmConfigMap;

/**
 * Normalize the optional top-level `llm:` block.
 * - undefined → undefined (pipeline-only configs stay valid)
 * - flat shape (has `provider`) → { main: flat } (backward compat)
 * - map shape → must include `main`; returned as NormalizedLlmMap
 */
export function normalizeLlmConfig(
  input?: SmartServerLlmConfig | LlmConfigMap,
): NormalizedLlmMap | undefined {
  if (input === undefined) return undefined;
  if (typeof (input as SmartServerLlmConfig).provider === 'string') {
    return { main: input as SmartServerLlmConfig } as NormalizedLlmMap;
  }
  const map = input as LlmConfigMap;
  if (!map.main) {
    throw new Error(
      "llm: map must include a 'main' key (default LLM for unspecified roles)",
    );
  }
  return map as NormalizedLlmMap;
}

/**
 * Resolve a per-role LLM config by name from a normalized map.
 * Lookup chain: map[name] → map.main → pipelineFallback.
 * When map is undefined, falls back to pipelineFallback (so pipeline-only
 * configs keep working with no top-level llm: block).
 *
 * The caller decides whether `undefined` is an error.
 */
export function resolveLlmConfig(
  map: NormalizedLlmMap | undefined,
  name?: string,
  pipelineFallback?: SmartServerLlmConfig,
): SmartServerLlmConfig | undefined {
  if (!map) return pipelineFallback;
  if (!name || name === 'main') return map.main;
  return map[name] ?? map.main;
}

/**
 * Read the reviewer block's LLM-name selector, accepting both the
 * preferred `reviewerLlm` field and the deprecated `plannerLlm` alias.
 * When the alias is used, calls `warn(message)`.
 */
export function resolveReviewerLlmName(
  block: { reviewerLlm?: string; plannerLlm?: string } | undefined,
  warn: (msg: string) => void,
): string | undefined {
  if (!block) return undefined;
  if (typeof block.reviewerLlm === 'string') return block.reviewerLlm;
  if (typeof block.plannerLlm === 'string') {
    warn(
      "coordinator.reviewer.plannerLlm is deprecated; rename to 'reviewerLlm'",
    );
    return block.plannerLlm;
  }
  return undefined;
}
```

> **Note on the fallback shape.** `pipeline.llm.main` is a `PipelineLlmProviderConfig` (uses `baseURL`, not `url`), so the caller in `smart-server.ts` MUST convert it to a `SmartServerLlmConfig`-compatible shape (`{ provider, apiKey, url: pipelineMain.baseURL, model, temperature }`) before passing it as `pipelineFallback`. The helper in Task 12 (`adaptPipelineToFallback`) does this once.

2. Update the `YamlCoordinator.reviewer` field to accept both names + add finalizer:

```ts
  reviewer?: {
    type?: string;
    reviewerLlm?: string;
    plannerLlm?: 'main' | 'planner' | 'helper';
  };
  finalizer?: {
    type?: 'passthrough' | 'llm' | 'template';
    finalizerLlm?: string;
    systemPrompt?: string;
  };
```

3. Loosen `assertLlmRoleShape` so it allows any string for the `plannerLlm` / `reviewerLlm` / `finalizerLlm` selector when the new map form is in use. Replace `assertLlmRoleShape` with:

```ts
function assertLlmRoleShape(label: string, role: unknown): void {
  if (typeof role !== 'object' || role === null || Array.isArray(role)) {
    throw new Error(
      `coordinator.${label} must be an object (e.g. { type: llm }), got: ${JSON.stringify(role)}`,
    );
  }
  const kind = (role as { type?: unknown }).type;
  if (
    kind !== undefined &&
    kind !== 'llm' &&
    !(label === 'finalizer' &&
      (kind === 'passthrough' || kind === 'template'))
  ) {
    throw new Error(
      `coordinator.${label}: unknown type '${String(kind)}'`,
    );
  }
  for (const field of ['plannerLlm', 'reviewerLlm', 'finalizerLlm'] as const) {
    const sel = (role as Record<string, unknown>)[field];
    if (sel !== undefined && typeof sel !== 'string') {
      throw new Error(
        `coordinator.${label}.${field} must be a string referencing an llm.* key, got: ${String(sel)}`,
      );
    }
  }
}
```

4. Update `SmartServerConfig.llm` type. Edit `packages/llm-agent-server/src/smart-agent/smart-server.ts` interface (line ~189):

```ts
  llm?: SmartServerLlmConfig | Record<string, SmartServerLlmConfig>;
```

- [ ] **10c. Build + test.**

```bash
npm --workspace @mcp-abap-adt/llm-agent-server run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/llm-map-normalize.test.ts
```

- [ ] **10d. Commit.**

```bash
git add packages/llm-agent-server/src/smart-agent/config.ts \
        packages/llm-agent-server/src/smart-agent/smart-server.ts \
        packages/llm-agent-server/src/smart-agent/__tests__/llm-map-normalize.test.ts
git commit -m "feat(server-config): widen llm: to optional named map + lookup helper

- SmartServerConfig.llm is now optional and accepts either the legacy
  flat shape OR a Record<string, LlmProviderConfig> with a required
  'main' key.
- normalizeLlmConfig rewrites flat→{main: flat} so existing configs
  keep working; resolveLlmConfig(map, name, pipelineFallback?) resolves
  a per-role name through the chain map[name] → map.main →
  pipelineFallback, so pipeline-only configs keep working with no
  top-level llm: block.
- coordinator.reviewer accepts both 'reviewerLlm' (preferred) and the
  deprecated 'plannerLlm' alias; the alias emits a warning.
- coordinator.finalizer schema parsed: { type: passthrough | llm |
  template, finalizerLlm?, systemPrompt? }.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11 — Parse `coordinator.finalizer.*` and select impl (with pipeline fallback)

- [ ] **11a. Write failing test.** Append to `packages/llm-agent-server/src/smart-agent/__tests__/llm-map-normalize.test.ts`:

```ts
import {
  LlmFinalizer,
  PassthroughFinalizer,
  TemplateFinalizer,
} from '@mcp-abap-adt/llm-agent-libs';
import { buildFinalizer } from '../config.js';

const stubLlm = {
  name: 'stub',
  async chat() {
    return {
      ok: true as const,
      value: { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    };
  },
};

test('buildFinalizer: omitted block returns PassthroughFinalizer', async () => {
  const f = await buildFinalizer(undefined, undefined, undefined, async () => stubLlm as never);
  assert.ok(f instanceof PassthroughFinalizer);
});

test('buildFinalizer: type=template returns TemplateFinalizer', async () => {
  const f = await buildFinalizer(
    { type: 'template' },
    undefined,
    undefined,
    async () => stubLlm as never,
  );
  assert.ok(f instanceof TemplateFinalizer);
});

test('buildFinalizer: type=llm uses resolved LLM from llm map (named override)', async () => {
  let askedFor: string | undefined;
  const map = normalizeLlmConfig({
    main: { provider: 'deepseek', apiKey: 'k' },
    finalizer: { provider: 'sap-ai-sdk', apiKey: 'k', model: 'sonnet' },
  } as never)!;
  const f = await buildFinalizer(
    { type: 'llm', finalizerLlm: 'finalizer', systemPrompt: 'CUSTOM' },
    map,
    undefined,
    async (cfg) => {
      askedFor = (cfg as never as { provider: string }).provider;
      return stubLlm as never;
    },
  );
  assert.ok(f instanceof LlmFinalizer);
  assert.equal(askedFor, 'sap-ai-sdk');
});

test('buildFinalizer: type=llm falls back to llm.main when finalizerLlm omitted', async () => {
  const map = normalizeLlmConfig({
    main: { provider: 'deepseek', apiKey: 'k' },
  } as never)!;
  let askedFor: string | undefined;
  const f = await buildFinalizer(
    { type: 'llm' },
    map,
    undefined,
    async (cfg) => {
      askedFor = (cfg as never as { provider: string }).provider;
      return stubLlm as never;
    },
  );
  assert.ok(f instanceof LlmFinalizer);
  assert.equal(askedFor, 'deepseek');
});

test('buildFinalizer: type=llm uses pipeline.llm.main fallback when no top-level llm map', async () => {
  // Pipeline-only config: no top-level llm: block, but pipeline.llm.main
  // is set. The chain top-level llm.<name> → llm.main → pipeline.llm.main
  // must resolve through the pipeline fallback.
  const pipelineFallback = {
    provider: 'openai',
    apiKey: 'k',
    model: 'gpt-x',
  } as never;
  let askedFor: string | undefined;
  const f = await buildFinalizer(
    { type: 'llm' },
    undefined,
    pipelineFallback,
    async (cfg) => {
      askedFor = (cfg as never as { provider: string }).provider;
      return stubLlm as never;
    },
  );
  assert.ok(f instanceof LlmFinalizer);
  assert.equal(askedFor, 'openai');
});

test('buildFinalizer: type=llm throws ConfigError when neither map nor pipeline fallback resolves', async () => {
  await assert.rejects(
    buildFinalizer(
      { type: 'llm' },
      undefined,
      undefined,
      async () => stubLlm as never,
    ),
    /requires an LLM config/,
  );
});
```

Run:

```bash
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/llm-map-normalize.test.ts
```

Expect failure (`buildFinalizer` missing).

- [ ] **11b. Implement.** Append to `packages/llm-agent-server/src/smart-agent/config.ts`:

```ts
import {
  LlmFinalizer,
  PassthroughFinalizer,
  TemplateFinalizer,
} from '@mcp-abap-adt/llm-agent-libs';
import type { IFinalizer, ILlm } from '@mcp-abap-adt/llm-agent';

export type FinalizerYaml = {
  type?: 'passthrough' | 'llm' | 'template';
  finalizerLlm?: string;
  systemPrompt?: string;
};

/**
 * Build the IFinalizer impl from `coordinator.finalizer:` YAML.
 *
 * Lookup chain for `type: llm`:
 *   resolveLlmConfig(llmMap, cfg.finalizerLlm, pipelineFallback)
 *   → top-level llm.<name> → llm.main → pipelineFallback (pipeline.llm.main)
 *   → ConfigError if all three are missing.
 *
 * Absent block / `type: passthrough` → PassthroughFinalizer.
 * `type: template` → TemplateFinalizer.
 */
export async function buildFinalizer(
  cfg: FinalizerYaml | undefined,
  llmMap: NormalizedLlmMap | undefined,
  pipelineFallback: SmartServerLlmConfig | undefined,
  makeLlm: (config: SmartServerLlmConfig) => Promise<ILlm>,
): Promise<IFinalizer> {
  const kind = cfg?.type ?? 'passthrough';
  if (kind === 'passthrough') return new PassthroughFinalizer();
  if (kind === 'template') return new TemplateFinalizer();
  // kind === 'llm'
  const resolved = resolveLlmConfig(llmMap, cfg?.finalizerLlm, pipelineFallback);
  if (!resolved) {
    throw new Error(
      "coordinator.finalizer (type: llm) requires an LLM config: provide top-level llm.<name>, llm.main, or pipeline.llm.main",
    );
  }
  const llm = await makeLlm(resolved);
  return new LlmFinalizer(llm, {
    systemPrompt: cfg?.systemPrompt,
  });
}
```

Update `packages/llm-agent-libs/src/coordinator/dag/index.ts` to export the new impls:

```ts
export { PassthroughFinalizer } from './passthrough-finalizer.js';
export { LlmFinalizer, FINALIZER_SYSTEM } from './llm-finalizer.js';
export { TemplateFinalizer } from './template-finalizer.js';
export { SubAgentStateOracle } from './subagent-state-oracle.js';
```

Update `packages/llm-agent-libs/src/index.ts` to re-export from coordinator/dag if the package's barrel does not already include it (verify the barrel reexports `coordinator/dag/index.js`; if not, add it).

- [ ] **11c. Build + test.**

```bash
npm --workspace @mcp-abap-adt/llm-agent-libs run build
npm --workspace @mcp-abap-adt/llm-agent-server run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/llm-map-normalize.test.ts
```

- [ ] **11d. Commit.**

```bash
git add packages/llm-agent-server/src/smart-agent/config.ts \
        packages/llm-agent-server/src/smart-agent/__tests__/llm-map-normalize.test.ts \
        packages/llm-agent-libs/src/coordinator/dag/index.ts \
        packages/llm-agent-libs/src/index.ts
git commit -m "feat(server-config): parse coordinator.finalizer.* and select impl

buildFinalizer(yaml, llmMap, pipelineFallback, makeLlm):
- absent / type=passthrough → PassthroughFinalizer
- type=template            → TemplateFinalizer
- type=llm                 → LlmFinalizer wrapping
                              resolveLlmConfig(llmMap, finalizerLlm,
                              pipelineFallback). Chain:
                              llm.<name> → llm.main → pipeline.llm.main.
- type=llm with no LLM available from ANY source → fail-loud ConfigError.

Also exports the four new impls from llm-agent-libs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12.0 — Audit `this.cfg.llm.*` reads in `smart-server.ts`

This is preparation for Task 12 — every read site must be routed through `resolveLlmConfig(map, name, pipelineFallback)` or guarded so it does not break when `cfg.llm` is undefined or a map.

- [ ] **12.0a. Run the audit.**

```bash
cd /home/okyslytsia/prj/llm-agent
grep -nE "(this\.)?cfg\.llm\." packages/llm-agent-server/src/smart-agent/smart-server.ts
```

At the time of this plan, the audit returns (verify before editing — line numbers shift as Tasks 10–11 land):

| Line | Site | Action in Task 12 |
|---|---|---|
| 616 | `this.cfg.llm.temperature` (in `mainTemp = Number(...)`) | Read from `resolved.temperature` of `resolveLlmConfig(llmMap, 'main', pipelineMainFallback)`; default 0.7. |
| 624 | `this.cfg.llm.provider ?? 'deepseek'` (in flat-fallback `makeLlm`) | Routed through the same resolved config. |
| 625 | `this.cfg.llm.apiKey` | Routed through resolved. |
| 626 | `this.cfg.llm.url` | Routed through resolved (note: `SmartServerLlmConfig.url`). |
| 627 | `this.cfg.llm.model` | Routed through resolved. |
| 634 | `this.cfg.llm.classifierTemperature` (in `classifierTemp`) | Guard with `topMain?.classifierTemperature` (only the FLAT shape has this field; map keys are per-role `SmartServerLlmConfig` and may share it). Read off `topMain` returned by `resolveLlmConfig(llmMap, 'main', pipelineMainFallback)`; default 0.1. |
| 645–648 | `this.cfg.llm.{provider,apiKey,url,model}` again (in classifier flat-fallback) | Routed through the same resolved config. |

- [ ] **12.0b. Verify the list is complete.**

```bash
cd /home/okyslytsia/prj/llm-agent
# After implementing Task 12 the count must drop to 0; before, it MUST match
# the rows above (8 hits). If grep returns extras, append them to the table.
grep -cnE "(this\.)?cfg\.llm\." packages/llm-agent-server/src/smart-agent/smart-server.ts
```

> **Implementer instruction:** if line numbers in `smart-server.ts` have shifted between the time this plan was written and the time you execute it, re-run the grep and update each site by code context (the exact field-read pattern, not the line number). No code change is committed in Task 12.0 — this task only produces the verified audit list used to drive Task 12.

---

### Task 12 — Server wiring: route LLMs through `resolveLlmConfig`, extract `buildDagCoordinatorDeps` seam, auto-wrap stateOracle, pass finalizer

This task is split into 12a (extracted seam helper + unit test) and 12b (`smart-server.ts` integration using the audit from Task 12.0).

#### Task 12a — Extract `buildDagCoordinatorDeps` seam + unit test

The seam is the unit-testable factory for the `withDagCoordinator` deps record. It encapsulates: planner LLM resolution, reviewer LLM resolution (with alias warning), error strategy, finalizer construction (via `buildFinalizer`), and oracle wrapping (via `SubAgentStateOracle`).

- [ ] **12a.1. Write failing test.** Create `packages/llm-agent-server/src/smart-agent/__tests__/build-dag-coordinator-deps.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ISubAgent } from '@mcp-abap-adt/llm-agent';
import {
  LlmFinalizer,
  PassthroughFinalizer,
  SubAgentStateOracle,
  TemplateFinalizer,
} from '@mcp-abap-adt/llm-agent-libs';
import { buildDagCoordinatorDeps } from '../build-dag-coordinator-deps.js';
import { normalizeLlmConfig } from '../config.js';

const stubLlm = {
  name: 'stub',
  async chat() {
    return {
      ok: true as const,
      value: {
        content: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  },
};

function makeOracle(name: string): ISubAgent {
  return {
    name,
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      return { output: 'X' };
    },
  };
}

function makeWorker(name: string): ISubAgent {
  return {
    name,
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      return { output: 'W' };
    },
  };
}

test('buildDagCoordinatorDeps: default finalizer is PassthroughFinalizer', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: { planner: { type: 'llm' } },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(deps);
  assert.ok(deps!.finalizer instanceof PassthroughFinalizer);
  assert.equal(deps!.stateOracle, undefined);
  assert.equal(deps!.reviewer, undefined);
  assert.ok(deps!.planner);
  assert.equal(deps!.workers.size, 1);
});

test('buildDagCoordinatorDeps: type=llm finalizer yields LlmFinalizer', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: {
      planner: { type: 'llm' },
      finalizer: { type: 'llm' },
    },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(deps!.finalizer instanceof LlmFinalizer);
});

test('buildDagCoordinatorDeps: type=template finalizer yields TemplateFinalizer', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: {
      planner: { type: 'llm' },
      finalizer: { type: 'template' },
    },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(deps!.finalizer instanceof TemplateFinalizer);
});

test('buildDagCoordinatorDeps: stateOracle name resolves and is wrapped in SubAgentStateOracle', async () => {
  const oracle = makeOracle('inspector');
  const registry = new Map<string, ISubAgent>([
    ['w', makeWorker('w')],
    ['inspector', oracle],
  ]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: { planner: { type: 'llm' }, stateOracle: 'inspector' },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(deps!.stateOracle instanceof SubAgentStateOracle);
  assert.equal(deps!.stateOracle?.name, 'inspector');
  // Oracle MUST be excluded from the workers set passed to the DAG.
  assert.equal(deps!.workers.has('inspector'), false);
  assert.equal(deps!.workers.has('w'), true);
});

test('buildDagCoordinatorDeps: returns undefined when planner block is absent (no coordinator)', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: { stateOracle: 'inspector' }, // no planner
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.equal(deps, undefined);
});

test('buildDagCoordinatorDeps: reviewer alias plannerLlm emits a warning', async () => {
  const warnings: string[] = [];
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  await buildDagCoordinatorDeps({
    coordCfg: {
      planner: { type: 'llm' },
      reviewer: { type: 'llm', plannerLlm: 'main' },
    },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: (m) => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plannerLlm.*deprecated/i);
});

test('buildDagCoordinatorDeps: pipelineFallback enables type=llm finalizer without top-level llm map', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: {
      planner: { type: 'llm' },
      finalizer: { type: 'llm' },
    },
    llmMap: undefined, // no top-level llm: block
    pipelineFallback: {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-x',
    } as never,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(deps!.finalizer instanceof LlmFinalizer);
});
```

Run:

```bash
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/build-dag-coordinator-deps.test.ts
```

Expect failure (module missing).

- [ ] **12a.2. Implement the seam.** Create `packages/llm-agent-server/src/smart-agent/build-dag-coordinator-deps.ts`:

```ts
import type {
  IErrorStrategy,
  IReviewStrategy,
  ISubAgent,
  ILlm,
} from '@mcp-abap-adt/llm-agent';
import {
  AbortErrorStrategy,
  DagPlanInterpreter,
  LlmDagPlanner,
  LlmReviewStrategy,
  ReplanErrorStrategy,
  SubAgentStateOracle,
} from '@mcp-abap-adt/llm-agent-libs';
import type { DagCoordinatorHandlerDeps } from '@mcp-abap-adt/llm-agent-libs';
import {
  buildFinalizer,
  resolveCoordinatorActivation,
  resolveLlmConfig,
  resolveReviewerLlmName,
  type NormalizedLlmMap,
} from './config.js';
import type { SmartServerLlmConfig } from './smart-server.js';

export interface BuildDagCoordinatorDepsInput {
  coordCfg: Record<string, unknown> | undefined;
  llmMap: NormalizedLlmMap | undefined;
  /** Adapted from `pipeline.llm.main` (already shape-normalized to
   *  SmartServerLlmConfig: `{ provider, apiKey, url: baseURL, model,
   *  temperature }`). When set, used as the final fallback in the
   *  role-resolution chain map[name] → map.main → pipelineFallback. */
  pipelineFallback: SmartServerLlmConfig | undefined;
  mainLlm: ILlm;
  helperLlm: ILlm | undefined;
  mainTemp: number;
  registry: ReadonlyMap<string, ISubAgent>;
  makeLlm: (config: SmartServerLlmConfig) => Promise<ILlm>;
  warn: (msg: string) => void;
}

export type BuiltDagCoordinatorDeps = Omit<
  DagCoordinatorHandlerDeps,
  'workers'
> & {
  workers: Map<string, ISubAgent>;
  oracleName?: string;
};

/**
 * Assemble the full deps record for `withDagCoordinator`. Returns
 * `undefined` when the YAML does not declare a DAG coordinator (no
 * `planner` block), so the caller can branch.
 *
 * Roles resolve their LLM via the chain:
 *   resolveLlmConfig(llmMap, name, pipelineFallback)
 *   → top-level llm.<name> → llm.main → pipelineFallback (pipeline.llm.main)
 */
export async function buildDagCoordinatorDeps(
  input: BuildDagCoordinatorDepsInput,
): Promise<BuiltDagCoordinatorDeps | undefined> {
  const {
    coordCfg,
    llmMap,
    pipelineFallback,
    mainLlm,
    helperLlm,
    mainTemp,
    registry,
    makeLlm,
    warn,
  } = input;

  if (!coordCfg || coordCfg.planner === undefined) return undefined;

  // ---- Planner ----------------------------------------------------------
  const plannerBlock = coordCfg.planner as {
    type?: string;
    plannerLlm?: string;
  };
  const plannerLlmCfg = resolveLlmConfig(
    llmMap,
    plannerBlock?.plannerLlm,
    pipelineFallback,
  );
  const plannerLlm = plannerLlmCfg
    ? await makeLlm({
        ...plannerLlmCfg,
        temperature: Number(plannerLlmCfg.temperature ?? mainTemp),
      })
    : mainLlm;
  const planner = new LlmDagPlanner(plannerLlm);

  // ---- Reviewer (optional) ---------------------------------------------
  let reviewer: IReviewStrategy | undefined;
  if (coordCfg.reviewer !== undefined) {
    const reviewerBlock = coordCfg.reviewer as {
      reviewerLlm?: string;
      plannerLlm?: string;
    };
    const reviewerName = resolveReviewerLlmName(reviewerBlock, warn);
    const reviewerCfg = resolveLlmConfig(
      llmMap,
      reviewerName,
      pipelineFallback,
    );
    const reviewerLlm = reviewerCfg
      ? await makeLlm({
          ...reviewerCfg,
          temperature: Number(reviewerCfg.temperature ?? mainTemp),
        })
      : mainLlm;
    reviewer = new LlmReviewStrategy(reviewerLlm);
  }

  // ---- Interpreter, workers, oracle, activation, error strategy --------
  const interpreter = new DagPlanInterpreter();

  const oracleName = coordCfg.stateOracle as string | undefined;
  let rawOracle: ISubAgent | undefined;
  if (oracleName) {
    rawOracle = registry.get(oracleName);
    if (!rawOracle) {
      throw new Error(
        `coordinator.stateOracle '${oracleName}' is not a declared subagent`,
      );
    }
  }
  const workers: Map<string, ISubAgent> = new Map(
    [...registry].filter(([name]) => name !== oracleName),
  );
  if (workers.size === 0) {
    throw new Error(
      'coordinator.planner is set (DAG mode) but no workers are configured. ' +
        'Add at least one entry under the top-level `subagents:` block.',
    );
  }
  const activation = resolveCoordinatorActivation(
    (coordCfg.activation ?? 'explicit') as string,
  );

  let errorStrategy: IErrorStrategy | undefined;
  const esCfg = coordCfg.errorStrategy as
    | { type?: string; maxReplans?: number }
    | undefined;
  if (esCfg?.type === 'replan') {
    errorStrategy = new ReplanErrorStrategy(planner, esCfg.maxReplans);
  } else if (esCfg?.type === 'abort') {
    errorStrategy = new AbortErrorStrategy();
  }

  // ---- Finalizer --------------------------------------------------------
  const finalizer = await buildFinalizer(
    coordCfg.finalizer as never,
    llmMap,
    pipelineFallback,
    async (lc) =>
      makeLlm({
        ...lc,
        temperature: Number(lc.temperature ?? mainTemp),
      }),
  );

  // ---- Oracle wrap ------------------------------------------------------
  const stateOracle = rawOracle
    ? new SubAgentStateOracle(rawOracle)
    : undefined;

  void mainLlm;
  void helperLlm;

  return {
    planner,
    interpreter,
    workers,
    activation,
    reviewer,
    errorStrategy,
    stateOracle,
    finalizer,
    maxRoundTrips: coordCfg.maxRoundTrips as number | undefined,
    oracleName,
  };
}
```

- [ ] **12a.3. Build + test.**

```bash
npm --workspace @mcp-abap-adt/llm-agent-libs run build
npm --workspace @mcp-abap-adt/llm-agent-server run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/build-dag-coordinator-deps.test.ts
```

- [ ] **12a.4. Commit.**

```bash
git add packages/llm-agent-server/src/smart-agent/build-dag-coordinator-deps.ts \
        packages/llm-agent-server/src/smart-agent/__tests__/build-dag-coordinator-deps.test.ts
git commit -m "feat(server): extract buildDagCoordinatorDeps seam

A pure async factory that assembles the withDagCoordinator deps
record from the YAML coord block + normalized LLM map + pipeline
fallback + subagent registry. Unit-testable in isolation — exercises
default-PassthroughFinalizer, type=llm finalizer, type=template
finalizer, oracle wrapping in SubAgentStateOracle, pipeline-fallback
chain, reviewer-alias warning, and the no-coordinator case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

#### Task 12b — Wire seam + resolved LLMs into `SmartServer`

This task uses the audit list from Task 12.0 and replaces the inline DAG branch in `smart-server.ts` with a `buildDagCoordinatorDeps` call.

- [ ] **12b.1. Sanity: existing wiring tests as the "failing" surface.**

```bash
cd packages/llm-agent-server && npx tsx --test \
  src/smart-agent/__tests__/dag-coordinator-config.test.ts \
  src/smart-agent/__tests__/existing-coordinator-yaml-loads.test.ts
```

Expect these to continue passing as Tasks 10–11 land; Task 12b only changes how the deps record is assembled, not the YAML schema. If a test fails because it asserts a closed `'main' | 'planner' | 'helper'` union on `reviewer.plannerLlm`, widen the assertion to `typeof === 'string'` in the same commit.

- [ ] **12b.2. Implement.** Edit `packages/llm-agent-server/src/smart-agent/smart-server.ts`:

1. Add imports near the other config imports:

```ts
import {
  assertCoordinatorConfigShape,
  buildFinalizer,
  normalizeLlmConfig,
  resolveCoordinatorActivation,
  resolveCoordinatorDispatch,
  resolveCoordinatorDispatchKind,
  resolveCoordinatorPlanning,
  resolveLlmConfig,
  resolveReviewerLlmName,
} from './config.js';
import { buildDagCoordinatorDeps } from './build-dag-coordinator-deps.js';
import { SubAgentStateOracle } from '@mcp-abap-adt/llm-agent-libs';
```

2. Near the top of `start()`, after `const pipeline = this.cfg.pipeline;`, normalize the LLM map AND derive the pipeline fallback in a single adapter so every downstream lookup uses the same fallback object:

```ts
    const warnings: string[] = [];
    const llmMap = normalizeLlmConfig(this.cfg.llm);

    // Adapt pipeline.llm.main (uses `baseURL`) → SmartServerLlmConfig (uses
    // `url`) so resolveLlmConfig's pipelineFallback parameter speaks one
    // shape. Returns undefined when no pipeline.llm.main is configured.
    const adaptPipelineToFallback = ():
      | import('./smart-server.js').SmartServerLlmConfig
      | undefined => {
      const pm = pipeline?.llm?.main;
      if (!pm) return undefined;
      return {
        provider: pm.provider,
        apiKey: pm.apiKey ?? '',
        url: pm.baseURL,
        model: pm.model,
        temperature: pm.temperature,
      };
    };
    const pipelineFallback = adaptPipelineToFallback();
```

3. **Replace EVERY `this.cfg.llm.*` read** with a single `resolveLlmConfig(llmMap, 'main', pipelineFallback)` call. The audit list from Task 12.0 enumerates the 8 sites in the current `mainLlm` + `classifierLlm` blocks (lines 615–651). Replace those blocks with:

```ts
    // ---- LLM resolution (top-level llm map → pipeline.llm.main chain) --
    const topMain = resolveLlmConfig(llmMap, 'main', pipelineFallback);

    const mainTemp = Number(
      pipeline?.llm?.main?.temperature ??
        topMain?.temperature ??
        0.7,
    );
    const mainLlm = pipeline?.llm?.main
      ? await makeLlm(pipeline.llm.main, mainTemp)
      : topMain
        ? await makeLlm(
            {
              provider: topMain.provider ?? 'deepseek',
              apiKey: topMain.apiKey,
              baseURL: topMain.url,
              model: topMain.model,
            },
            mainTemp,
          )
        : (() => {
            throw new Error(
              'no LLM configured: provide top-level llm.main or pipeline.llm.main',
            );
          })();

    const classifierTemp = Number(
      pipeline?.llm?.classifier?.temperature ??
        topMain?.classifierTemperature ??
        0.1,
    );
    const classifierLlm = pipeline?.llm?.classifier
      ? await makeLlm(pipeline.llm.classifier, classifierTemp)
      : pipeline?.llm?.main
        ? await makeLlm(pipeline.llm.main, classifierTemp)
        : topMain
          ? await makeLlm(
              {
                provider: topMain.provider ?? 'deepseek',
                apiKey: topMain.apiKey,
                baseURL: topMain.url,
                model: topMain.model,
              },
              classifierTemp,
            )
          : (() => {
              throw new Error(
                'no LLM configured: provide top-level llm.main or pipeline.llm.main',
              );
            })();
```

After this replacement, re-run the Task 12.0 grep — it MUST return zero `this.cfg.llm.*` hits.

4. Replace the inline DAG branch (~lines 886–988 today) with a call to `buildDagCoordinatorDeps`:

```ts
      if (coordCfg.planner !== undefined) {
        const interpKind = (
          coordCfg.interpreter as { type?: string } | undefined
        )?.type;
        if (interpKind !== undefined && interpKind !== 'dag') {
          throw new Error(
            `coordinator.interpreter: unknown type '${interpKind}' (only 'dag' is supported)`,
          );
        }

        const built = await buildDagCoordinatorDeps({
          coordCfg: coordCfg as Record<string, unknown>,
          llmMap,
          pipelineFallback,
          mainLlm,
          helperLlm,
          mainTemp,
          registry,
          makeLlm: async (lc) =>
            makeLlm(
              {
                provider: lc.provider ?? 'deepseek',
                apiKey: lc.apiKey,
                baseURL: lc.url,
                model: lc.model,
              },
              Number(lc.temperature ?? mainTemp),
            ),
          warn: (m) => log({ event: 'config_warning', message: m }),
        });
        // built is defined when coordCfg.planner !== undefined.
        if (!built) {
          throw new Error('internal: buildDagCoordinatorDeps returned undefined despite planner present');
        }

        const { oracleName, ...deps } = built;
        builder = builder.withDagCoordinator(deps);
        this._dagCoordinatorTemplate = {
          deps: {
            planner: deps.planner,
            interpreter: deps.interpreter,
            activation: deps.activation,
            reviewer: deps.reviewer,
            errorStrategy: deps.errorStrategy,
            finalizer: deps.finalizer,
            maxRoundTrips: deps.maxRoundTrips,
          },
          oracleName,
        };
        log({ event: 'dag_coordinator_configured', config: coordCfg });
      } else {
        // Linear mode: existing path, route plannerLlm through the new map.
        const linearPlannerName = coordCfg.plannerLlm as string | undefined;
        const linearPlannerCfg = resolveLlmConfig(
          llmMap,
          linearPlannerName,
          pipelineFallback,
        );
        const plannerLlm = linearPlannerCfg
          ? await makeLlm(
              {
                provider: linearPlannerCfg.provider ?? 'deepseek',
                apiKey: linearPlannerCfg.apiKey,
                baseURL: linearPlannerCfg.url,
                model: linearPlannerCfg.model,
              },
              Number(linearPlannerCfg.temperature ?? mainTemp),
            )
          : linearPlannerName === 'helper' || linearPlannerName === 'planner'
            ? (helperLlm ?? mainLlm)
            : mainLlm;
        // … rest of linear branch unchanged (planningKind, dispatchKind, etc.)
```

5. Update `_dagCoordinatorTemplate` field type at line ~595 — the deps now include `finalizer`, and `stateOracle` is `IStateOracle`:

```ts
  private _dagCoordinatorTemplate?: {
    deps: Omit<DagCoordinatorHandlerDeps, 'workers' | 'stateOracle'>;
    oracleName?: string;
  };
```

(`finalizer` is part of `DagCoordinatorHandlerDeps` and is therefore included in the `Omit<…, 'workers' | 'stateOracle'>` projection — the type signature is correct without changes; verify after rebuild.)

6. In `buildSessionAgent` (line ~1497) wrap the per-session oracle through the adapter:

```ts
      if (this._dagCoordinatorTemplate) {
        const tpl = this._dagCoordinatorTemplate;
        const workers: SubAgentRegistry = new Map(
          [...registry].filter(([name]) => name !== tpl.oracleName),
        );
        const raw = tpl.oracleName ? registry.get(tpl.oracleName) : undefined;
        b = b.withDagCoordinator({
          ...tpl.deps,
          workers,
          stateOracle: raw ? new SubAgentStateOracle(raw) : undefined,
        });
      }
```

7. Update `resolveSmartServerConfig` in `packages/llm-agent-server/src/smart-agent/config.ts` (around line 842) to allow a missing `llm:` block — replace the unconditional `llm: { … }` literal with:

```ts
    llm: get(yaml, 'llm')
      ? (typeof get(yaml, 'llm', 'provider') === 'string'
          ? {
              provider: get(yaml, 'llm', 'provider') as
                | 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk' | 'ollama'
                | undefined,
              apiKey,
              url: get(yaml, 'llm', 'url') as string | undefined,
              model: get(yaml, 'llm', 'model') as string | undefined,
              temperature: Number(get(yaml, 'llm', 'temperature') ?? 0.7),
              classifierTemperature: Number(
                get(yaml, 'llm', 'classifierTemperature') ?? 0.1,
              ),
            }
          : (get(yaml, 'llm') as Record<string, SmartServerLlmConfig>))
      : undefined,
```

- [ ] **12b.3. Verify audit complete + build + run ALL server-package tests.**

```bash
cd /home/okyslytsia/prj/llm-agent
# Must return 0 hits.
grep -cnE "(this\.)?cfg\.llm\." packages/llm-agent-server/src/smart-agent/smart-server.ts

npm --workspace @mcp-abap-adt/llm-agent-server run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/*.test.ts
```

All existing tests + the new wiring/seam tests must pass. Fix any regressions iteratively (especially `dag-coordinator-config.test.ts` and `existing-coordinator-yaml-loads.test.ts` assertions on `reviewer.plannerLlm` types).

- [ ] **12b.4. Commit.**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts \
        packages/llm-agent-server/src/smart-agent/config.ts
git commit -m "feat(server): wire IFinalizer + IStateOracle into SmartServer

- Top-level llm: is resolved through normalizeLlmConfig once at start.
- Every this.cfg.llm.* read is replaced by resolveLlmConfig(llmMap,
  'main', pipelineFallback), so pipeline-only configs (no top-level
  llm: block) continue to work — the lookup chain map[name] →
  map.main → pipeline.llm.main covers the role-resolution mandate
  from spec C.2.
- The inline DAG branch in start() is replaced by a call to the new
  buildDagCoordinatorDeps seam, which encapsulates planner/reviewer
  LLM resolution, finalizer construction, error strategy, oracle
  wrapping in SubAgentStateOracle, and worker registry shaping.
- buildSessionAgent re-uses the captured template and re-wraps the
  per-session oracle in SubAgentStateOracle.
- Linear coordinator planner LLM also routes through the map chain.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13 — Per-package test sweep

- [ ] **13a. Run every package's tests.**

```bash
cd /home/okyslytsia/prj/llm-agent
npm --workspace @mcp-abap-adt/llm-agent run build
npm --workspace @mcp-abap-adt/llm-agent-libs run build
npm --workspace @mcp-abap-adt/llm-agent-server run build

cd packages/llm-agent      && npx tsx --test src/**/__tests__/*.test.ts
cd ../llm-agent-libs       && npx tsx --test src/**/__tests__/*.test.ts
cd ../llm-agent-server     && npx tsx --test src/smart-agent/__tests__/*.test.ts
```

Verify zero failures. Run lint:

```bash
cd /home/okyslytsia/prj/llm-agent
npm run lint
```

- [ ] **13b. Commit lint fixes if any (no behaviour changes).**

```bash
git add -u
git commit -m "chore(lint): biome auto-fixes after DAG roles completion

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(Skip this commit if `git status` is clean after lint.)

---

## Self-Review (spec → task mapping)

| Spec requirement | Implementing task(s) |
|---|---|
| **A.1** `IFinalizer` interface in `packages/llm-agent/src/interfaces/finalizer.ts` | Task 2 |
| **A.2** PassthroughFinalizer / LlmFinalizer / TemplateFinalizer impls | Tasks 3, 4, 5 |
| **A.3** Handler integration — `deps.finalizer` normalized via `?? new PassthroughFinalizer()`; finalize called after `interpret`; trace built from `result.executionOrder` + `result.executedPlan` | Task 9 |
| **A.4** YAML `coordinator.finalizer.*` parsed; absent → Passthrough; `type: llm` honours `finalizerLlm` / `systemPrompt` | Tasks 10, 11, 12a, 12b |
| **B.1** `IStateOracle` interface in `packages/llm-agent/src/interfaces/state-oracle.ts` | Task 6 |
| **B.2** `SubAgentStateOracle` adapter + **double-count contract** (`usage: undefined` even when inner returns usage) | Task 7 (impl + test); Task 9 (handler logs `'oracle'`, no-op when usage undefined) |
| **B.3** Handler `NeedInfoSignal` branch rewritten to `stateOracle.query(...)`; `logRoleUsage('oracle', …)` | Task 9 |
| **C.1** YAML `llm:` becomes optional map keyed by role name | Tasks 10, 12b |
| **C.2** Normalizer (`normalizeLlmConfig`) + lookup helper (`resolveLlmConfig` with `pipelineFallback`) + reviewer key alias (`reviewerLlm` + deprecated `plannerLlm` with warning) + coordinator role-resolution chain (top-level llm.<name> → llm.main → pipeline.llm.main → ConfigError) | Task 10 (helpers + alias + fallback param); Task 11 (`buildFinalizer` accepts fallback); Task 12a (seam threads fallback through every role); Task 12b (server adapts `pipeline.llm.main` and passes it everywhere) |
| **C.3** Worker-internal LLM map untouched | (no-op; out-of-scope reaffirmed in plan) |
| **D** Logger: `LlmComponent` += `'finalizer' \| 'oracle'`; `CATEGORY_MAP` += both → `auxiliary` | Task 1 |
| **E.1** PassthroughFinalizer returns interpreterOutput verbatim (multi-terminal DAG) | Task 3 |
| **E.2** LlmFinalizer: no tools wired + FINALIZER_SYSTEM + returns usage | Task 4 |
| **E.3** TemplateFinalizer: deterministic markdown join | Task 5 |
| **E.4** DAG coordinator invokes `finalizer.finalize(...)` after `interpret`; tokens land in `byComponent.finalizer` via `runRole('finalizer', …)` + existing terminal-yield usage path | Task 9 |
| **E.5** SubAgentStateOracle maps `query→task`, `output→answer`; forwards `trace`/`sessionLogger`; **returns `usage: undefined`** | Task 7 |
| **E.6** Subagent-backed oracle does NOT add to `byComponent.oracle` (because `logRoleUsage` no-ops on undefined usage) | Task 7 (contract enforced) + Task 9 (handler honours it) |
| **E.6a** Pure-LLM oracle stub returning populated `usage` → `byComponent.oracle` populated | Task 9 (the `IStateOracle` stub in 9a returns usage; the handler calls `logRoleUsage('oracle', …)`. An explicit `LlmStateOracle` impl is not in scope per the spec — "rare; not the standard config".) |
| **E.7** Flat `llm: { provider: X, … }` rewritten to `{ main: flat }` via `normalizeLlmConfig` | Task 10 |
| **E.8** Map with multiple keys + `plannerLlm: planner` resolves to the correct entry via `resolveLlmConfig` | Task 10 |
| **E.9** Default fallback: `plannerLlm` absent → uses `llm.main` (and `pipeline.llm.main` if no top-level map) | Task 10 (helper) + Task 12b (server-side adapter) |
| **Interpreter `executedPlan` on success + `executionOrder`** | Task 8 |
| **`this.cfg.llm.*` audit + replacement** | Task 12.0 (audit), Task 12b (replacement; verified by grep returning 0 hits) |
| **`buildDagCoordinatorDeps` seam (unit-testable wiring)** | Task 12a |
| **Tag/branch hygiene** (branch `epic/session-scoped-infrastructure`; conv. commits + Co-Authored-By trailer) | All tasks |

## Out of scope (per spec)

- Per-role LLM for worker-internal stages.
- `IBudgetStrategy`, `IDispatchStrategy`, `IPlanReducer`, `IClarificationStrategy`, `ITraceFormatter`, `ISessionGraphFactory`, `IRagAccessPolicy`.
- Finalizer with tools enabled (intentional restriction).
