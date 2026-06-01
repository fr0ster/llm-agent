# 18.1 — Stepper Evaluator + recursion hardening (spec)

**Status:** active (design settled in the 18.0 session; this formalizes it for implementation).
**Branch:** `epic/18.1-evaluator` (off `main` @ v18.0.0).
**Source design:** `experiments/2026-05-31-pipeline-tool-search/DESIGN-18.0-stepper.md` §"Live findings",
§"Gather vs analyze", §"deep-stepper = special case of flow", §"The EVALUATOR".

## Goal

Make Stepper decomposition **assess the (sub-)prompt at every level** instead of relying on prompt
wording, and make recursion safe to re-enable. The 18.0 live matrix proved the gaps: bare
cyclic/planned do not read includes (no completeness assessment), and `executor: recursive` /
`mode: deep-stepper` ran away (141 spawns, no termination/dedup) — both were deferred to 18.1.

This is **one control-flow redesign** delivered as 5 sequenced, independently-testable phases. The
**Evaluator** is the spine; identity-dedup is a prerequisite for safe recursion.

## Non-goals

- No new LLM providers / transports / RAG backends.
- No change to the agnostic floor: "what completeness means" stays the consumer's RAG skills
  (`knowledgeSeed` + tool descriptions), never hardcoded tool names or task recipes.
- Semantic (qdrant/pg) knowledge-RAG `query()` ranking is still a separate post-18.x enhancement;
  the identity-dedup here is an exact-key manifest, NOT semantic ranking.

## The core idea — the Evaluator (linchpin)

A new component, distinct from planner (decomposes the task) and reviewer (reviews OUTPUT): the
**Evaluator judges the INPUT** — the completeness/executability of a (sub-)prompt, **WITH the RAG
context** (consumer skills + already-gathered blackboard facts) — and returns a verdict the
coordinator acts on:

1. **executable** — doable unambiguously with what is known/available → terminal executor leaf, do
   NOT recurse. (This IS the recursion termination condition.)
2. **needs-work** — something missing but obtainable (fetch/do/check/decompose) → plan gather/
   sub-steps and recurse. The verdict NAMES what is missing (gap analysis).
3. **needs-consumer** — only the consumer can resolve it (a decision / knowledge external to the
   system) → return up to the coordinator as a clarify (human-in-the-loop).

This one verdict subsumes prompt-completeness/gap-analysis, the termination condition,
plan-review-for-completeness, and the clarify policy.

---

## Phase 1 — IEvaluator contract + LlmEvaluator + Stepper wiring (the spine)

**Files**
- Create `packages/llm-agent/src/interfaces/evaluator.ts` — `IEvaluator`, `EvaluatorVerdict`.
- Export from `packages/llm-agent/src/interfaces/index.ts`.
- Create `packages/llm-agent-libs/src/coordinator/stepper/llm-evaluator.ts` — `LlmEvaluator`,
  `EVALUATOR_SYSTEM`.
- Modify `packages/llm-agent-libs/src/coordinator/stepper/stepper.ts` — run the Evaluator in
  `run()` before `planner.plan()` and branch on the verdict.
- Modify `packages/llm-agent-server/src/smart-agent/build-stepper-root.ts` — build + share one
  `LlmEvaluator` (role `evaluator` → `main`); thread into every `buildNode`.
- Modify `packages/llm-agent-server/src/smart-agent/config.ts` — `coordinator.flow.evaluator`
  (`{ enabled?: boolean; atDepths?: number[] | 'all'; systemPrompt?: string }`), default
  enabled with `atDepths: 'all'` for planned/deep, `enabled:false` preset for bare cyclic (opt-in).

**Contract**
```ts
export type EvaluatorRoute = 'executable' | 'needs-work' | 'needs-consumer';
export interface EvaluatorVerdict {
  route: EvaluatorRoute;
  /** For needs-work: the named gaps (what to gather/do first). For needs-consumer:
   *  the questions to ask. Empty for executable. */
  missing: string[];
  /** One-line rationale (logged; not shown to the consumer unless needs-consumer). */
  reason?: string;
}
export interface IEvaluator {
  readonly name: string;
  evaluate(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;   // gather already-known facts WITH context
    toolsRag: IToolsRagHandle;           // what CAN be obtained → needs-work vs needs-consumer
    taskSpec?: ITaskSpec;                // overall-intent anchor
    identity: RunIdentity;
    signal?: AbortSignal;
  }): Promise<EvaluatorVerdict>;
}
```

**Stepper.run wiring** (replaces the current "plan → maybe-review → interpret"):
```
verdict = evaluator.evaluate(prompt, knowledgeRag, toolsRag, taskSpec)   // if enabled at this depth
switch verdict.route:
  executable    → interpret a single trivial node {goal: prompt} (terminal; no planner)
  needs-work    → plan = planner.plan(prompt + verdict.missing as gap hints) → reviewer → interpret
  needs-consumer→ return IStepperResult { status:'clarify', questions: verdict.missing } up the tree
```
- The Evaluator's `evaluate` MUST query `knowledgeRag` (already-gathered facts) and `toolsRag`
  (obtainability) — route 2 vs 3 hinges on "can a listed tool get it?".
- `needs-consumer` propagates: the interpreter/coordinator surfaces a clarify result to the HTTP
  layer (reuse the existing `ClarifySignal` plumbing where possible; see §Open questions).
- Disabled (or depth not in `atDepths`) → behaves exactly as 18.0 (plan → interpret).

**Reconcile the 18.0 workaround:** when the Evaluator is enabled, REMOVE the soft completeness
clause from `STEPPER_PLANNER_SYSTEM` (it double-judges). Keep `EXECUTOR_SYSTEM` task-agnostic
(already reverted in 18.0). The Evaluator — not prompt wording — is what makes cyclic/planned
"know" includes are a prerequisite.

**Tests (node --test via tsx):**
- LlmEvaluator returns `executable` when RAG already has the needed artifact (stub RAG with the
  fact) and `needs-work` (with the gap named) when it does not but a tool can get it.
- `needs-consumer` when no listed tool can obtain the missing fact.
- Stepper.run: `executable` → planner is NOT called (spy planner); `needs-work` → planner called
  with the gap hints; `needs-consumer` → returns a clarify result, interpreter NOT called.
- Evaluator disabled / depth filtered → identical path to 18.0 (regression guard).

---

## Phase 2 — Identity-keyed blackboard dedup (prerequisite for safe recursion)

**Problem (live):** the planner's `query(prompt,k:8)` and executor's `query(prompt,k:5)` are
semantic top-k on TEXT — they cannot reliably answer "is include _O01 already fetched?", so the
same include is re-fetched (~2×) and re-planned (×3). The "RAG-FIRST: don't re-fetch" promise must
be backed by an exact-identity lookup.

**Files**
- `packages/llm-agent/src/interfaces/knowledge-rag.ts` — add an identity manifest API:
  `hasArtifact(key: string): Promise<boolean>` + `listArtifacts(): Promise<{key:string; toolName:string; createdAt:string}[]>`.
- `packages/llm-agent-libs/src/coordinator/stepper/cyclic-react-executor.ts` — when writing an
  `mcp-result`, set `metadata.identityKey = stableArgsKey(toolName, args)` (reuse the helper
  already in `smart-server.ts` — promote it to `@mcp-abap-adt/llm-agent`).
- The JSONL knowledge backend — index by `identityKey`; `hasArtifact` is an exact map lookup.
- `llm-stepper-planner.ts` — render an **"Already fetched (do not re-fetch)"** manifest block
  (from `listArtifacts`) into the planning prompt, distinct from the lossy semantic "Known facts".

**Tests:** writing two results with the same `(tool,args)` yields one manifest entry; `hasArtifact`
true after write; planner prompt contains the manifest block; a fetch step for an already-fetched
identity is not emitted (assert on the stub-LLM input the planner sees).

---

## Phase 3 — Gather/analyze phasing + dependsOn dataflow

**Problem (live):** `dependsOn` is ORDERING-only — `composeTask` (interpreter:140) passes
`objective + node.goal`, never the predecessor's OUTPUT. So an `analyze` node `dependsOn:[gather]`
never receives gathered source → it re-fetches.

**Files**
- `packages/llm-agent-libs/src/coordinator/stepper/stepper-interpreter.ts` — thread the OUTPUT of
  `dependsOn` predecessors into the dependent node's context (explicit predecessor outputs OR an
  identity-keyed blackboard read from Phase 2 — NOT semantic top-k). Extend `composeTask`.
- Plan shape — allow a node `phase: 'gather' | 'analyze'`. Fetch tools permitted ONLY for `gather`
  nodes; `analyze` nodes run read-free with predecessor data in context. (Enforced softly: analyze
  nodes get the gathered context and an instruction; hard tool-gating is optional — see open Qs.)

**Tests:** an `analyze` node `dependsOn:[gather]` receives gather's output in its executor prompt
(assert on the executor's first user message); a 2-node gather→analyze plan calls the fetch tool
only in gather.

---

## Phase 4 — Layered recursion + termination (re-enable deep-stepper as a flow preset)

**Files**
- `packages/llm-agent-server/src/smart-agent/config.ts` — STOP rejecting `executor: recursive` /
  `mode: deep-stepper`. `mode: deep-stepper` becomes a PRESET = flow + `recursion: { enabled:true,
  maxDepth }` + Evaluator-as-terminator. `flow.executor: recursive` allowed when the Evaluator is
  enabled (guard: recursion without an Evaluator is rejected — that is what ran away).
- `packages/llm-agent-libs/src/coordinator/stepper/` — recursion is **demand-driven + layered**:
  a node recurses ONLY when the Evaluator returns `needs-work` (Phase 1); the executor→planner
  escalation spawns a child Stepper for the sub-goal. Identity-dedup (Phase 2) prevents
  re-planning already-done work. Breadth-first per level; bounded by `maxDepth` + token budget.

**Tests:** a recursive run terminates (Evaluator `executable` halts a branch); identity-dedup
prevents the same `(tool,args)` across levels (assert call count); `executor:recursive` without an
Evaluator is rejected by config parsing; a deep run on a compound goal does NOT exceed a sane spawn
bound (regression guard against the 141-spawn runaway).

---

## Phase 5 — Reviewer judges plan completeness WITH RAG context + bounded replan

**Files**
- `packages/llm-agent-libs/src/coordinator/stepper/stepper.ts` — the reviewer block (currently
  reviews then `void result`) must (a) query the RAG context, (b) on a completeness rejection
  trigger ONE bounded replan, (c) drop unneeded steps (the live "unneeded CheckProgram").
- `packages/llm-agent-libs/src/coordinator/stepper/` reviewer strategy — accept RAG context;
  judge the plan against "what completeness means" from the consumer's skills.

**Tests:** reviewer rejection triggers exactly one replan then proceeds; reviewer sees RAG facts in
its input; no infinite replan loop.

---

## Verification (live, after Phases 1–5) — honest re-run of the 18.0 matrix

On `:3001` (mcp-abap-adt, SAP live), AI Core (sonnet eval/plan/finalize + haiku exec), Qdrant.
Program ZDAZ_R_DELAYED_UPDATE (6 includes). Save each pipeline's full answer separately + a
COMPARISON in a clean `.run/test-*` folder (same discipline as the 18.0 matrix).

Must prove:
1. **bare cyclic/planned read all 6 includes via the Evaluator** (no prompt prerequisite, no seed) —
   the 18.0 gap closed by assessment, not wording.
2. **deep-stepper terminates** (no runaway; bounded spawns) and reads includes once each (dedup).
3. **flow** re-verified after identity-keyed reads: analyze never re-reads.
4. No regression in DAG / the 18.0 green test suites.

## Build order & dependencies

```
Phase 1 (Evaluator)  ──────────────┐
Phase 2 (identity-dedup) ──┐        │
                           ├─► Phase 4 (recursion) ─► live verify
Phase 3 (phasing/dataflow)─┘        │
Phase 5 (reviewer completeness) ────┘
```
Phase 1 first (spine). Phase 2 before Phase 4 (recursion needs dedup). Phases 3 & 5 are
independently valuable and can land in any order after Phase 1.

## Open questions (resolve during planning)

1. **Clarify plumbing for `needs-consumer`:** reuse the existing `ClarifySignal` / budget-extension
   path, or a dedicated `IStepperResult.status: 'clarify'`? (Lean: extend the existing signal.)
2. **Evaluator default for cyclic:** off by default (cyclic stays thin, consumer-driven) or on?
   (Lean: off for `mode: cyclic-react`; on for planned/deep — confirm with user.)
3. **Hard vs soft gather/analyze tool-gating** (Phase 3): refuse fetch tools on analyze nodes, or
   only steer via context + prompt? (Lean: soft first, measure.)
4. **One Evaluator LLM role or reuse `planner`?** (Lean: its own `evaluator` role → `main`, so a
   deployment can point it at a strong model independently.)

## Decisions already fixed (do NOT re-litigate)

- Evaluator + reviewer both judge WITH RAG context.
- "What completeness means" = consumer RAG skills, never hardcoded.
- Planner ≠ executor (smart plans, cheap executes); executor never self-assesses completeness.
- deep-stepper = flow + recursion flag (not a separate mode).
- Engine agnostic; pipeline may be gnostic but not super-gnostic; minimize context explosion
  (bounded compact propagation, never full-history re-query).
