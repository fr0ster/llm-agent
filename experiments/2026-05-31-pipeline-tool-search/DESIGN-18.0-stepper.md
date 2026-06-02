# 18.0 Stepper design (deep-stepper returned to 18.0) — task anchoring + bounded context propagation

Derived from the 2026-05-31 pipeline comparison (see `COMPARISON.md`, `METRICS.md`).

## Canonical architecture — coordinator as composition (no `mode` enum)

There are **no execution modes**. There is ONE coordinator that runs a flow assembled
from components. cyclic / planned / deep / flat / DAG are just component combinations.

`coordinator` is the mandatory entry: top level = the coordinator's **implementation +
settings**; nested `flow` (child level) = the **program flow** it runs.

```yaml
coordinator:
  type: stepper                 # coordinator implementation
  maxParallelSteps: 4
  maxDepth: 5
  tokenBudget: 300000
  mutationPolicy: confirm
  knownReadOnlyTools: [GetProgram, GetInclude, ...]
  flow:
    planner:     { type: llm | static | none }     # none/trivial = "as before"
    interpreter: { type: default }                 # SAME impl at general level AND at step level
    executor:    { type: simple | cyclic-react | recursive }
    reviewer:    { atDepths: [0,1] }               # optional
    finalizer:   { type: llm | passthrough }       # optional
    plan: [ {id, goal, dependsOn?}, ... ]          # optional declarative (static) sequence
```

- `{planner, interpreter, executor, reviewer, finalizer}` **is** a Stepper, applied
  **recursively**: recursion = a node whose executor is itself a Stepper of the same
  composition. The **interpreter is shared across all levels** (general + step) — it walks
  the plan and routes each node to the executor or into a child Stepper.
- The `mode` enum is removed; keep it as a **preset alias** that expands to a composition
  (backward-compat). Legacy DAG (`coordinator.planner`, no mode) already IS such a composition.
- Three declarative layers, all visible in yaml: **stages** (how a step runs, `pipeline.stages`)
  → **plan** (sequence of steps: `flow.plan` static ↔ planner dynamic) → **TaskSpec** (the
  overall task; see below).

| form | flow.planner | flow.executor |
|---|---|---|
| flat (as before) | none/trivial | simple (node = prompt, one pass) |
| cyclic | trivial (1 node) | cyclic-react |
| planned | llm (flat graph) | simple/cyclic, walks the plan |
| deep | llm (recursive) | recursive |
| DAG | llm | worker-pipeline |
| static | static (`flow.plan`) | any |

"What is happening" is answerable because the yaml declares the composition + (for static)
the sequence; for dynamic plans the plan + TaskSpec are first-class logged artifacts.

### Two knobs: planner granularity × executor type (eager ⊻ lazy decomposition)

There is ALWAYS a planner. What varies is **where and how much** decomposition happens,
and **whether the executor itself recurses**. Two orthogonal knobs:

1. **`planner.granularity`** — how much the planner decomposes UP FRONT:
   - `shallow` — a few high-level steps (read → analyze → finalize); detail deferred.
   - `detailed` — full decomposition into concrete leaves immediately.
   - (`static` planner: detail = the yaml plan itself; `none`: no plan.)
2. **`executor.type`** — what a node's executor does:
   - `simple` — single pass (one tool round + synthesis); walks a leaf, no planning/spawning.
   - `cyclic-react` — ReAct loop on the node (multi-round tools); still a leaf.
   - `recursive` — the node spawns a child Stepper (its own planner+executor) → decomposition ON DEMAND.

**Decomposition is eager ⊻ lazy:** eager = the planner decides up front (detailed plan +
simple executor); lazy = a recursive executor re-plans as it goes (shallow plan + recursive).

| Case | planner.granularity | executor.type | where decomposition lives |
|---|---|---|---|
| 1 — shallow multi-step plan + simple leaf | `shallow` | `cyclic-react` | eager-shallow only |
| 2 — shallow plan, executor recurses (plans + spawns) | `shallow` | `recursive` | eager-shallow + **lazy** |
| 3 — detailed plan up front + simple leaf | `detailed` | `simple` | **eager-detailed** only |

```yaml
coordinator:
  flow:
    planner:   { type: llm | static | none, granularity: shallow | detailed }
    interpreter: { type: default }
    executor:  { type: simple | cyclic-react | recursive }
    reviewer:  { atDepths: [...] }
    finalizer: { type: llm }
    plan: [...]    # static
```

Implementation note: `simple` = the leaf executor run single-pass (low maxIterations); `cyclic-react`
= the full ReAct loop; `recursive` = leaf executor + child-Stepper recursion. `granularity` switches
the LLM planner's decompose directive (shallow DAG vs full concrete-leaf decomposition).

### Extended intent: decomposition criteria live in RAG (consumer skills)

Each level's planner states the GOAL of its steps; the **criteria for HOW to decompose a
goal are RAG data (consumer skills), not code**. Example for the test prompt "do a code
review":

```
review  →  [read code, analyze]
analyze →  [security, CleanCore, performance, maintainability]
security →  [check vuln A, check vuln B, …]      ← WHICH checks come from RAG
```

Because the agent is agnostic, even "which checks make up a security analysis" is read from
RAG. The planner is RAG-first:

1. **Criteria already in RAG** → emit a step per criterion (or one bulk step — see below).
2. **RAG says "fetch the criteria from resource X"** → plan a FETCH operation (find the ABAP
   security checks → write them to the knowledge-RAG blackboard), then form the per-check steps.
   The "resource X" and how to reach it are a procedural consumer skill in RAG — the engine
   knows neither.

**Two execution strategies (operator-chosen via the two knobs):**
- **Bulk** — the executor pulls the known checks from RAG (factsPrefix) and runs them in ONE
  LLM pass. `granularity: shallow` + `executor: simple|cyclic-react`. Cheap; works today.
- **Per-check** — a step / child Stepper per check. `granularity: detailed` (eager) or
  `executor: recursive` (lazy). High fidelity; costlier; bound by maxDepth + token budget.

**New capability required for the fine-grained "fetch criteria → decompose per criterion":
staged planning (plan → fetch → re-plan).** A Stepper currently plans ONCE, so it cannot both
fetch the criteria AND decompose by them in a single pass. Needed: a planner that **re-plans
after a knowledge-fetch enriches the blackboard** (or the recursive executor escalates back to
the planner with the now-enriched RAG). Everything else already exists: RAG-first planning,
fetch steps, shared blackboard. Bulk needs no re-plan and is the default; staged per-check is
the advanced mode (guard cost — uncontrolled recursion is how deep ran away).

### "Additional steps" = ORCHESTRATION phases, not domain operations

Critical distinction:

- **Domain operations** (fetch the source, read includes, run a check) are NEVER declared in
  yaml. They are produced by the planner (dynamically, RAG-driven) and carried out by the
  executor using the consumer's RAG skills. Hard-coding a "fetch source" step would be gnostic —
  it does not belong in the flow.
- **Orchestration phases** ARE what the flow declares — the coordinator's PROGRAM:

```
plan  →  [review-plan]  →  execute  →  [re-plan]  →  finalize
```

So "additional steps" the operator adds to a flow are **phases** like **plan-review** (critique
the produced plan BEFORE executing it — distinct from the execution-time reviewer at depths) or
**re-plan** (after a plan-review or a knowledge-fetch). They are NOT domain nodes.

```yaml
coordinator:
  flow:
    planner:     { type: llm | static | none, granularity: shallow | detailed }
    interpreter: { type: default }
    planReview:  { enabled: true }          # ← NEW phase: review the PLAN before execution
    executor:    { type: simple | cyclic-react | recursive }
    reviewer:    { atDepths: [0, 1] }       # execution-time review (during the run)
    finalizer:   { type: llm }
```

- The phase order is the coordinator's program; optional phases (`planReview`, re-plan) are
  switched on per flow.
- A `static` plan (`flow.plan`), if ever used, lists **intent-level goals** ("Analyze security",
  "Analyze performance") — NEVER fetch/tool procedures; data-gathering is still the executor's
  job driven by RAG skills.
- **plan-review phase** — NEW capability: the reviewer evaluates the PLAN (not execution
  output) and may trigger a bounded re-plan. Today the reviewer only runs during execution at
  `atDepths`. Noted as an extension to build.
- **Hybrid (mandatory explicit steps + LLM-planned rest)** — also not yet; `static` is all
  explicit, `llm` is all generated.

### yaml is a STRUCTURAL composition tree (presence = exists; nesting = a sub-cycle)

The flow is NOT a fixed set of steps toggled on/off. It is structural:

- **A node present in yaml ⇒ that step EXISTS.** Absent ⇒ it does not. No enable/disable flags
  for a canned step list.
- **A node with a NESTED `flow` ⇒ a SEPARATE cycle with its own steps** — i.e. a sub-Stepper
  with its own planner/interpreter/executor loop, scoped to that node.

```yaml
coordinator:
  flow:
    planner:  { type: llm, granularity: shallow }
    executor: { type: cyclic-react }
    nodes:
      - id: read
        goal: "Read the code"          # leaf — executed by the executor
      - id: analyze
        flow:                          # NESTED flow ⇒ a separate sub-cycle for this node
          planner:  { type: llm, granularity: detailed }
          executor: { type: cyclic-react }
          nodes:
            - { id: security, goal: "Analyze security" }
            - { id: perf,     goal: "Analyze performance" }
```

So the yaml is a **FINITE tree of compositions**: every node is either a leaf (run by the
executor) or nests its own `flow` (a sub-Stepper) — but you write N levels and stop.

**Nested `flow.nodes` is NOT recursion (corrected 2026-06-01).** Recursion = unbounded
self-similar expansion to a termination condition; its depth is unknown at config time, so it
cannot be a finite yaml structure. yaml can at most carry a FLAG ("recurse here" + maxDepth) or a
named-flow self-reference; the EXPANSION is RUNTIME (a node spawns a same-shaped child until
termination). 18.0 ships finite declared trees only. True recursion (`executor: recursive` /
`mode: deep-stepper`) is rejected by parsing and deferred to 18.1 — it requires the Evaluator
(the termination judge, judging WITH RAG context) + identity-keyed dedup so it does not run away.

### One composition model, two front-ends (yaml AND code builder)

Everything expressible in yaml MUST be expressible through the code builder — and vice versa.

- **Single canonical composition spec** (`CompositionSpec`: planner, interpreter, executor,
  reviewer, finalizer, nested `nodes` with optional sub-`flow`).
- **yaml parser → CompositionSpec**; **SmartAgentBuilder → the SAME CompositionSpec**; the
  runtime (`buildStepperRoot`/`Stepper`) consumes ONLY the spec, never raw config. No yaml-only
  features.
- **The code builder adds what yaml cannot: injecting custom IMPLEMENTATIONS.** yaml selects
  built-in types by string (`planner: { type: llm }`); the builder can pass instances
  (`planner: new MyPlanner()`, custom `IExecutor`/`IReviewStrategy`/`IFinalizer`/`ILlm`) —
  consistent with "consumers implement their own interfaces".

Implementation consequence: split `buildStepperRoot` into `parseStepperConfig → CompositionSpec`
(yaml front-end) and `builder → CompositionSpec` (code front-end), then a single
`buildFromComposition(spec)`. This makes yaml⟷builder parity structural, not duplicated.

```ts
builder.coordinator({
  planner:  { type: 'llm', granularity: 'shallow' },   // or: planner: new MyPlanner()
  executor: { type: 'cyclic-react' },                  // or: executor: new MyExecutor()
  reviewer: { atDepths: [0] },
  finalizer:{ type: 'llm' },
  nodes: [
    { id: 'read', goal: 'Read the code' },
    { id: 'analyze', flow: { /* nested sub-cycle = nested yaml node */ } },
  ],
});
```

### Live findings 2026-06-01 (gate-free matrix) → planning hardening

1. **Blackboard dedup is lossy (redundant fetches).** The executor DOES write every tool result
   to the knowledge-RAG (`knowledgeRag.write`, artifactType `mcp-result`). But both the planner's
   RAG-first check (`query(prompt, k:8)`) and the executor's pre-loop seed (`query(prompt, k:5)`)
   are bounded SEMANTIC top-k queries keyed on the prompt TEXT — not on object identity. So
   "is include _O01 already fetched?" is not reliably answered → the same include is re-fetched
   (flow read each include ~2×) and re-PLANNED (deep planned "_O01 via GetProgram" AND "via
   GetInclude" ×3). Fix: **identity-keyed dedup** — index fetched artefacts by tool+args (or
   object name) and have the planner/executor consult a "what's already fetched" manifest, not
   just semantic top-k. The "RAG-FIRST: don't re-fetch" promise must be backed by identity lookup.

2. **The plan is not assessed for COMPLETENESS (hardest component).** planned-react produced
   [GetProgram → CheckProgram → analyze] — it included an unneeded CheckProgram step and NO
   include-fetch step, so the analysis ran on the main shell only. The reviewer exists but reviews
   execution at depths, NOT the plan's completeness. Needed:
   - a **pre-planning prompt-completeness / gap step**: does the prompt contain everything needed
     to execute? If not, what else must be KNOWN or DONE first? (This is the TaskSpec formalizer
     extended into gap analysis — the consumer's RAG skills supply "what completeness means".)
   - a **plan-review phase** that judges the plan for completeness/correctness (drop the unneeded
     CheckProgram; ensure includes are covered) and triggers a bounded re-plan.
   This is likely the single hardest component.

3. **Recursive decomposition must be LAYERED with a termination condition (deep runaway, 141
   spawns).** deep did NOT re-run the original prompt; it re-planned OVERLAPPING sub-goals at every
   level (same include via different tools, ×3) with no dedup → combinatorial explosion → budget
   exhausted → finalizer non-answer. The intended shape:
   - **Layered / breadth-first per level:** L1 = [read code, analyze, finalize]; then deepen step 1
     ("what is read-code, how — concrete steps"), etc.
   - **Termination condition (the crux):** at each node ask — can this be executed UNAMBIGUOUSLY
     in one step? → terminal (executor leaf). Else → analyse what is missing / must be known or
     done, assess, then recurse (planner + executor). This is the executor↔planner escalation made
     into a per-node decision, anchored by identity-keyed dedup (1) so already-done work is not
     re-planned.

### Gather vs analyze: read ONLY in the gather phase; analyze consumes context

Fetching (reading source/includes) must happen ONLY in the information-GATHERING phase. By the
analysis phase the code (incl. includes) must ALREADY be in the node's context — analysis must
NOT re-fetch. deep violates this: its analyze sub-steppers re-plan/re-fetch includes (×3). Two
gaps cause it:

1. **`dependsOn` is ORDERING-only, not DATAFLOW.** The interpreter runs each node with
   `composeTask(node, plan)` = objective + node.goal; it does NOT pass the OUTPUT of the node's
   `dependsOn` predecessors into the dependent node's context. So an `analyze` node that
   `dependsOn: [gather]` never receives gather's output — only its own goal + a k=5 semantic
   factsPrefix.
2. **Blackboard read-back is lossy** (see Live findings #1): even though gather wrote the code to
   the knowledge-RAG, `query(prompt, k:5)` keyed on text may not surface it → analyze can't see
   it → it re-fetches.

**Fix (18.1):**
- **Phase the plan:** gather steps (reads) → analyze steps (`dependsOn` the gather steps). Fetch
  is permitted ONLY in gather steps; analyze steps are read-free.
- **Dataflow along `dependsOn`:** thread the gather steps' OUTPUT (the collected source +
  includes) into the analyze node's context — explicitly (predecessor outputs) or via an
  identity-keyed blackboard read, NOT lossy semantic top-k. Then analyze has "the code already in
  context" and never re-reads.

### deep-stepper = a special case of flow (unified model)

flow is the general composition; **deep-stepper is flow with recursion enabled** — not a separate
mode. In 18.1, `mode: deep-stepper` becomes a PRESET = flow + a node recursion flag + `maxDepth` +
the Evaluator as the termination judge. The knobs parameterize one model: recursion on/off, depth
limit, evaluator-driven termination. (18.0 ships flow with recursion OFF.)

**18.0 caveat (per user 2026-06-01):** non-recursive flow ships "for now", but MUST be
re-verified AFTER the planner reads the RAG context properly. Today the planner's RAG-first check
is lossy (semantic top-k, not identity-keyed) → it does not reliably see already-gathered facts →
redundant fetch / under-planning (04-flow "worked" but re-read includes). After identity-keyed
reads, re-check that flow produces a clean result.

### The EVALUATOR — per-level task assessment that drives the coordinator (linchpin)

Without evaluating the (sub-)prompt at EVERY level there will always be problems. The unifying
control component is an **Evaluator/Assessor** that runs at each level and returns a verdict the
coordinator acts on. It is distinct from the planner (decomposes the task) and the reviewer
(reviews execution OUTPUT): the Evaluator judges the INPUT — the completeness/executability of
the (sub-)prompt — before/around planning.

**Three routes (the verdict → coordinator control):**
1. **executable** — the (sub-)prompt can be done unambiguously with what is known/available →
   terminal step (executor); do NOT recurse. (This is the termination condition.)
2. **needs-work** — something is missing but the agent CAN obtain it (fetch / do / check /
   decompose) → the coordinator plans gather/sub-steps and recurses. The verdict names WHAT is
   missing (gap analysis).
3. **needs-consumer** — something is missing that only the consumer can resolve (a decision, or
   knowledge external to the system) → the coordinator returns to the consumer with clarifying
   questions (human-in-the-loop).

This single verdict subsumes the previously-scattered pieces: prompt-completeness / gap analysis,
the recursion termination condition, plan-review-for-completeness, and the clarify policy. "What
completeness means" is AGNOSTIC — it comes from the consumer's RAG skills (the criteria for
routes 1/2/3 are the consumer's domain rules), never hardcoded. This is the hardest component and
the spine of the recursive control + human-in-the-loop.

**18.0 workaround (revisit in 18.1):** a SOFT completeness clause was added to
`STEPPER_PLANNER_SYSTEM` and `EXECUTOR_SYSTEM` ("before concluding an analysis, ensure you have
the COMPLETE artifact incl. all parts; plan prerequisite steps"). It is a stand-in for this
Evaluator. **When the dedicated Evaluator lands it may DOUBLE-JUDGE / conflict with these prompt
clauses** — reconcile then (likely remove the prompt clauses, or make them complementary). Test
whether the workaround alone makes bare cyclic/planned read includes.

**Both the Evaluator and the reviewer MUST judge WITH the RAG context (confirmed 2026-06-01).**
The Evaluator assesses the (sub-)prompt against the RAG context (consumer skills + already-gathered
blackboard facts) — otherwise it cannot know what "complete/executable" means or what is already
done. Likewise the **reviewer must check plan/output completeness WITH the RAG context**, not in
isolation. Evaluation or review without querying the RAG context will misjudge routes 1/2/3.

### Separation of planner and executor (responsibilities)

Planner and executor are **distinct components, distinct LLM roles, distinct concerns** — never merged:

- **Planner (smart model, e.g. sonnet)** — decides WHAT and the SEQUENCE: decomposition, graph,
  dependencies. Owns the approach.
- **Executor (cheap model, e.g. haiku)** — executes ONE concrete node with tools. It does NOT
  re-plan the task or choose the approach; its ReAct loop is bounded to fulfilling its node's goal
  (gather data, call tools) under the TaskSpec anchor.

Anti-pattern (observed in cyclic-react): a trivial planner + a ReAct executor pushes the *planning*
burden onto the cheap executor → it improvises the whole task → fabrication / 0 tool calls. Fix: for
non-trivial tasks use a real planner that emits concrete nodes; the executor only executes. A trivial
planner is acceptable only when the node is genuinely a single concrete step.

### Executor → planner escalation (demand-driven recursion)

The executor does not plan, but it **may call the planner**. Executor outcomes:

1. **done** — has the data from tools → answer.
2. **need-tool** — a capability/tool is missing (`needResolver`).
3. **need-plan (escalate)** — the node turned out to be compound / not solvable in one step →
   the executor (haiku) **invokes the planner (sonnet)** on that sub-goal → sub-plan →
   interpreter → child executors. Bounded by `maxDepth` + token budget.

This keeps the separation (the cheap executor *delegates* planning, it does not improvise it) and
makes recursion **demand-driven**: the tree grows only where an executor actually hits complexity,
grounded on real tool results — instead of the root planner speculatively pre-decomposing everything.
This is the cure for BOTH failure modes seen on 2026-05-31: cyclic's fabrication (no escalation →
improvise) and deep's runaway (root over-decomposed up front → 107 spawns / 0 tool calls). Mechanically
"executor calls planner" = the executor spawns a child Stepper (same composition) for the sub-goal.

## Architecture decision (fixed)

- **Engine (`llm-agent`) stays agnostic.** No hardcoded tool names; tool search = semantic
  match over tool **descriptions** behind `IToolsRagHandle` / `IToolSelectionStrategy`.
- **The concrete pipeline is allowed to be gnostic** — we deploy for an ABAP system over
  mcp-abap-adt, so a deployment may specialize. But **not super-gnostic**: tasks differ; the
  only thing we always know is "operate on an ABAP system via MCP". Bake that floor, not task
  recipes.
- **Minimize context explosion.** REJECT iterative re-query over the full, growing conversation
  (the DAG `tools_refreshed` behaviour) — it bloats the prompt. Prefer **bounded, compact**
  context propagation (a few lines), not full history.

## Confirmed gap (code-grounded)

- `stepper-interpreter.ts:140 composeTask` passes only ONE level: `Objective: <current plan>\nTask: <node.goal>`.
- On recursion the child builds its own plan with its own `objective`, so the **root objective
  survives one hop and dilutes at depth ≥2**.
- `parentPath: string[]` exists on the planner input but carries **IDs, not goal texts**, and is
  not rendered into the planning/tool-search prompt.
- The executor sees only its node `prompt` + `factsPrefix` (knowledge-RAG) — never the ancestor
  chain. Result: sub-steppers "concentrate on the current sub-task and forget it is part of the whole."
- Even **cyclic** keeps the main task only in the first user message; it gets buried as tool
  results accumulate (worse for a haiku executor).

## Quality asymmetry

Root planner = sonnet (best plan); executor = haiku (cheap, weak). The cheap leaf CANNOT
reconstruct the big picture — so the strong plan must **hand context down**; do not expect the
leaf to re-derive it.

## 18.1 levers (all bounded, no context explosion)

1. **Persistent main-task anchor — ALL modes, EVERY iteration (incl. cyclic).**
   Keep the main objective pinned in every executor turn (stable header / system-prompt line /
   re-injected compact reminder), so the model never loses the overall goal as the tool log grows.

2. **Ancestor goal-chain (planned / deep).** Thread a compact `ancestorGoals: string[]`
   (root objective → … → parent goal → this node) through `composeTask` / the interpreter.
   Feed it into (a) the node prompt and (b) the **tool-search query**, so retrieval reflects the
   overall intent, not just the narrow sub-goal. Bounded — a few short lines, not the full convo.

3. **Anti-fabrication "via MCP only" clause in `EXECUTOR_SYSTEM`** (agnostic).
   "Never recall or invent object contents from memory; everything you report must come from a
   tool result in THIS run. If you have not retrieved it, you do not know it." Fixes cyclic's
   0-call fabrication.

4. **Light ABAP+MCP gnostic floor** (deployment seed, not engine): "You work on an ABAP system
   via MCP tools; operate only on real retrieved data." No task-specific procedures.

5. **readOnly gate → graceful skip, not run-killer.** A non-read-only tool call must yield a
   skip / inline clarify, not abort the whole coordinator (planned-react died on `CheckProgram`).

6. **deep root-planner must ground sub-goals in retrieval before recursing.** It recursed into
   107 child Steppers with 0 MCP calls and exhausted the budget — anchor each sub-goal to a real
   fetch first.

## Explicitly NOT doing

- Iterative tool re-selection over the full evolving conversation (context explosion).
- A "smarter agnostic" engine reranker as the primary fix — the gnostic deployment + bounded
  goal-chain + anti-fabrication prompt are cheaper and sufficient.
