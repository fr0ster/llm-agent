# Pipeline Catalog

> Status: **analysis / decision-input**, 2026-06-05.
> Inventory of every coordinator/pipeline variant the runtime ships today, with
> honest strengths and weaknesses. Written to ground the next architecture
> decision (component-composition vs. YAML; multi-process flow; explicit
> planner-controller ↔ executor split). It documents *what exists*, not what we
> wish existed.

## How a pipeline is selected today

A request is served by exactly one **coordinator handler**, chosen at config
build time (`packages/llm-agent-libs/src/pipeline/handlers/index.ts`):

| `coordinator` | Handler | Shape |
|---|---|---|
| *(absent)* | flat `SmartAgent` tool-loop | single agent, no decomposition |
| `linear` | `CoordinatorHandler` | one task list, dispatched in order |
| `dag` | `DagCoordinatorHandler` | planner → parallel workers → finalizer |
| `stepper` | `StepperCoordinatorHandler` | composition flow over an executor |

Sub-selectors:

- **flat mode** — `mode: pass | smart | hard`
- **linear dispatch** — `self | hybrid | compose-task | subagent`
- **stepper mode** (preset) — `cyclic-react | planned-react | deep-stepper`,
  or an explicit `coordinator.flow` block overriding per-component:
  - `planner.type: none | llm | static`, `planner.granularity: shallow | detailed`
  - `executor.type: simple | cyclic-react | recursive`
  - `finalizer.type: llm | template | passthrough` *(passthrough not yet implemented)*
  - `evaluatorEnabled: bool` *(required for `recursive`)*
- **DAG finalizer** — `llm | template | passthrough`

The four axes we judge every variant on (the recurring pain points):

1. **External-tool fit** — can a consumer-supplied tool be surfaced mid-run and
   resumed without re-running/regenerating? (see
   `docs/superpowers/` round-trip notes; content-bearing args break stateless re-run.)
2. **Planner ↔ executor separation** — is there an *explicit* plan-and-control
   stage distinct from the doing stage, or are they fused?
3. **Gnosticization** — how does an agnostic pipeline get specialised to a
   concrete prompt/domain (RAG skills, knowledge seed, …)?
4. **YAML expressiveness** — what can the declarative config express, and where
   does it become a millstone?

---

## 1. Flat SmartAgent (no coordinator)

**What:** A single `SmartAgent` runs the LLM tool-loop directly. `mode`:
- `pass` — no tools, straight passthrough to the model.
- `smart` — full tool-loop (RAG + MCP tools), the default.
- `hard` — tool-loop with stricter gating (external tools dropped historically;
  the #171 work softened this).

**Select:** omit `coordinator`; set `mode`.

**Strengths:**
- Lowest latency and token overhead; one LLM context, no orchestration.
- Simplest mental model; easiest to debug.
- Streaming is natural and uninterrupted.

**Weaknesses:**
- No decomposition — large/multi-step tasks overflow one context.
- No parallelism.
- Planner/executor fused into the model's own ReAct.

**Per-axis:**
- *External tools:* the original surfacing path; works for stable-arg tools,
  fragile for content-bearing args (the round-trip problem originates here).
- *Planner↔executor:* none — implicit in the model.
- *Gnosticization:* RAG skills + system prompt only.
- *YAML:* trivially expressible; this is YAML's sweet spot.

---

## 2. Linear coordinator

**What:** A task list executed in order; each task dispatched via a strategy:
- `self` — the main agent executes each step in its own loop.
- `hybrid` — main agent for some steps, subagent for others.
- `compose-task` — composes a single task spec then runs it.
- `subagent` — every step delegated to a fresh subagent (isolated context).

**Select:** `coordinator: linear`, `coordinator.dispatch: …`.

**Strengths:**
- Predictable, ordered execution; easy to reason about.
- `subagent` dispatch gives per-step context isolation (no pollution).
- Good for genuinely sequential workflows.

**Weaknesses:**
- No parallelism even when steps are independent.
- The "plan" is a flat list — no dependency graph, no re-planning.
- Planner is thin/absent; mostly a fixed sequence.

**Per-axis:**
- *External tools:* per-step; a step that surfaces an external tool has the same
  resume problem as flat, now multiplied across steps.
- *Planner↔executor:* weak separation — dispatch chooses *who* runs, not an
  explicit plan-then-control split.
- *Gnosticization:* RAG skills per step.
- *YAML:* the list + dispatch knob fit YAML; dependencies/branching do not.

---

## 3. DAG coordinator

**What:** A planner emits a dependency graph of nodes; independent nodes run as
**parallel subagent workers**; a finalizer synthesises the result.
- finalizer `llm` — model-written synthesis.
- finalizer `template` — deterministic templated merge.
- finalizer `passthrough` — return last/joined worker output.

**Select:** `coordinator: dag`, `coordinator.finalizer.type: …`.

**Strengths:**
- Real parallelism across independent nodes (`maxParallelSteps`).
- Explicit dependency graph — the clearest "plan as data" we have.
- Worker isolation (fresh subagent per node).
- #171 added external-tool surfacing with collect-all-at-settle.

**Weaknesses:**
- **External-tool resume is stateless** (#171): a worker that surfaces an
  external tool is finalized, and leg-2 re-runs from history. For
  content-bearing args the regenerated `extId` differs → no correlation →
  re-surface. (This is the live-tested break that triggered the redesign.)
- Planner is one-shot; no mid-run re-planning when a node's result reshapes the
  graph.
- Finalizer can hallucinate a synthesis if workers were thin.
- The worker does its *own* ReAct — so even here planning and doing are fused
  *inside* each node.

**Per-axis:**
- *External tools:* surfaced, but **not** suspend/resume — stateless re-run only.
- *Planner↔executor:* graph-level separation (planner builds graph, workers
  execute) — the best of the current set — but **intra-node** it's fused.
- *Gnosticization:* planner + per-worker RAG skills.
- *YAML:* the graph is awkward to author by hand; usually planner-generated.

---

## 4. Stepper coordinator (composition flow)

**What:** A composition of named components over a shared executor. Presets:

| Mode | planner | executor | Notes |
|---|---|---|---|
| `cyclic-react` | `none` | `cyclic-react` | trivial planner; ReAct loop does everything |
| `planned-react` | `llm` | `cyclic-react` | LLM plans, ReAct executes (default) |
| `deep-stepper` | `llm` | `recursive` | Evaluator-fenced recursive decomposition |

An explicit `coordinator.flow` block overrides per-component and can declare
**nodes** with `dependsOn` (a concurrent-leaf flow), plus a `knowledgeSeed`
(the **gnostic** variant: curated domain guidance injected into planning).

**Select:** `coordinator: stepper`, `coordinator.mode: …` or `coordinator.flow: …`.

**Strengths:**
- Most flexible of the current set — composition, not a mode enum.
- `planned-react` gives a real LLM planning stage before execution.
- `deep-stepper` + Evaluator handles deep/uncertain decomposition and is where
  the "needed tool absent from RAG → explicit error" guard lives.
- Flow nodes + `dependsOn` express partial-order concurrency.
- `knowledgeSeed` is the cleanest gnosticization hook we have.

**Weaknesses:**
- **The planner/executor split is still not clean.** We expected the cyclic
  model to give an explicit *planner-controller* driving a separate *executor*;
  instead `cyclic-react` fuses them (the executor re-plans inside its own loop),
  and `planned-react`'s planner is one-shot, not a live controller.
- **External tools in the executor are the hard case.** The cyclic executor
  must *wait* (suspend) for a consumer round-trip; today it cannot park a live
  continuation, so it inherits the stateless-re-run problem.
- `coordinator.flow` is **hard to author in YAML** — nodes, dependsOn, per-component
  types, evaluator wiring — exactly the "YAML as millstone" symptom.
- `finalizer.passthrough` declared but not implemented.

**Per-axis:**
- *External tools:* worst-fit today — the executor's live loop is precisely
  what must suspend/resume, and YAML/stateless model can't express it.
- *Planner↔executor:* *intended* to be the clean split; **in practice fused**.
  This is the central gap motivating the redesign.
- *Gnosticization:* `knowledgeSeed` + RAG skills — the strongest story.
- *YAML:* presets fit; explicit `flow` composition does not.

---

## Cross-cutting findings

**External tools.** Every variant surfaces consumer tools but **none** truly
suspends and resumes a live worker; all fall back to stateless re-run, which is
correct only for stable-arg tools. Content-bearing args (a generated review)
regenerate a different `extId` and re-surface. Retrofitting suspend/resume into
the existing stateless pipelines is "lots of limitations or not at all."

**Planner ↔ executor.** No variant gives a clean, explicit *planner-controller*
distinct from an *executor*. DAG separates at the graph level but fuses inside
each node; stepper was meant to separate them and fused them in the loop. This
is the structural gap.

**Gnosticization.** Handled today only by RAG skills + `knowledgeSeed` + system
prompt — i.e. *content* injected into an agnostic pipeline. There is no
*structural* gnosticization (specialising the composition itself to a prompt).

**YAML expressiveness.** YAML fits flat/preset cases cleanly and becomes a
millstone the moment we need: dependency graphs, per-component implementation
choice, multi-process interaction, or suspend/resume semantics. These are
naturally *code-composition* concerns, not declarative-config concerns.

## Conclusion (decision input)

The variants form a capability ladder (flat → linear → DAG → stepper) but share
three ceilings: fused planner/executor, stateless external tools, and YAML that
cannot express the compositions we now want. Rather than retrofit suspend/resume
into each, the next step is a **component-composition** architecture where
consumers build agents from composable components in code (as we build the
defaults), each **flow node is an in-process "process"** with explicit intra-
and inter-process interaction, planner-controller and executor are **explicit
separate components**, and YAML is demoted to a **thin preset** for simple cases.
That design is brainstormed separately; this catalog is its baseline.
