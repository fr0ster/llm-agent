# Controller Pipeline — Design

> Status: **design / in-review**, 2026-06-06.
> A new built-in pipeline plugin (`controller`) for the v19 plugin-pipeline
> architecture. Peer to `flat`/`linear`/`dag`/`stepper`; does NOT touch stepper.

## 1. Motivation

A consumer prompt often needs to be **planned** and **executed step-by-step**, with
context **enriched from RAG/MCP** along the way — work a bare LLM/agent cannot do
alone. Today a human shepherds this manually against an agent: notices "I need the
includes", fetches them, feeds them back, repeats. The `controller` pipeline
**automates that loop**: the consumer sends a prompt and gets a complete result; the
controller fetches from RAG/MCP what a bare agent would ask the human for, and
escalates to the consumer only when information is genuinely unavailable internally
(a true external tool, or a clarification).

The key shape: a **deterministic Coordinator** orchestrates **opaque subagents**
(reached over a protocol) through an **incremental, goal-driven loop**, owning all
tool-routing, memory, consumer dialogue, and escalation.

## 2. Goals / Non-goals

**Goals**
- New peer pipeline plugin `controller`; reuse the v19 plugin contract + infra.
- Deterministic Coordinator (no own LLM) + three opaque subagent roles
  (`evaluator`, `planner` [planner-reviewer], `executor`), each independently
  configurable (own adapter/endpoint/model) — separate config, no side-effects.
- Incremental planning: the planner returns the **next step**, not a full plan;
  it tracks progress, re-plans, and detects goal completion.
- Guaranteed session isolation via **data/code separation**: state is per-session
  DATA in RAG; code + subagent endpoints are stateless. No heavy/live session.
- Suspend/resume across consumer requests achieved through **persisted data**, not
  in-memory continuations.

**Non-goals**
- Touching/evolving `stepper` (separate peer).
- A heavy stateful session with reconnect (the session is a light RAG-hydrated bundle).
- Full upfront plans / fixed stage state-machines (planning is incremental).
- Multi-endpoint specialization beyond the three roles (later; roles may share an
  endpoint initially).

## 3. Architecture

```
Consumer ──request──▶ Coordinator (deterministic, no LLM)
                         │  hydrate session bundle from RAG (user+session scope)
                         │
                         ├─▶ Evaluator   (opaque endpoint)  → target-state + validate
                         │
                         │  loop (bounded):
                         ├─▶ Planner     (opaque endpoint)  → next-step | done | rewind
                         ├─▶ Executor    (opaque endpoint)  → content | tool_call | error
                         │     ├ tool_call→ internal (callMcp) | external (ext: round-trip)
                         │     └ result  → memorizer writes artifact to session-memory
                         │  (planner observes updated clean-global → next | done)
                         │
                         └─▶ finalize → result ;  persist bundle ;  (or escalate)
```

- **Coordinator** — deterministic glue: consumer interface, session hydrate/persist,
  subagent invocation, tool routing (internal/external), memory writes, escalation,
  budget enforcement. Holds NO cross-request state.
- **Evaluator** (subagent) — establishes + validates the **target state** from the
  prompt (see §7). Distinct role so it is configured independently.
- **Planner-Reviewer** (subagent) — given (its private context + the clean global +
  the target state) returns the **next step**, or `done`, or `rewind`; self-grounds
  (drift / goal-distance) against the clean global; re-plans dynamically.
- **Executor** (subagent) — executes the next step's instructions with the context
  the Coordinator injected; returns `content | tool_call | error`.

Subagents are **opaque endpoints behind a pluggable protocol adapter**
(`openai` | `anthropic` | `custom`); the Coordinator passes the full role context in
every call (stateless to the subagent). Subagents evolve independently without
breaking the Coordinator.

## 4. Plugin placement (reuse the v19 contract)

`controller` is a new `IPipelinePlugin` in `llm-agent-server-libs/src/pipelines/`.
`build(cfg, ctx)` constructs a `ControllerCoordinatorHandler` (an `IStageHandler`)
and wires it as the agent's coordinator:

```ts
async build(cfg, ctx: IServerPipelineContext): Promise<IPipelineInstance> {
  const handler = new ControllerCoordinatorHandler(cfg, ctx);
  const builder = await ctx.createAgentBuilder();
  const handle = await builder.withStepperCoordinator(handler).build();
  return { agent: handle.agent, close: () => handle.close() };
}
```

(`withStepperCoordinator` is the builder's generic "register the coordinator stage
handler" path — reused, not stepper-specific.)

## 5. Subagents

A subagent role = `{ provider, url, model, auth }` (a provider/endpoint config). The
Coordinator talks to each via an `ISubagentClient` built over the **outbound `ILlm`**
abstraction, resolved with `ctx.makeLlm(roleConfig)` (or `ctx.resolveLlm(role)`),
which already provides OpenAI/Anthropic chat + tool_calls. A remote OpenAI-compatible
endpoint (e.g. another agent on `:3001`) is reached via an `openai` provider with a
custom `baseURL`; `custom` = a consumer-supplied `ILlm`. The client normalizes a chat
completion into `{ kind: 'content' | 'tool_call' | 'error', ... }`. Roles:
`evaluator`, `planner`, `executor`. In the MVP they MAY point to the same endpoint,
but they are three independently-configurable roles.

> **Layer caveat (review):** do NOT build subagent clients on `ILlmApiAdapter` —
> that abstraction normalizes the server's **inbound** HTTP API surface
> (OpenAI/Anthropic-compatible endpoints the server exposes), not **outbound** chat
> calls to a model. Outbound = `ILlm` via `ctx.makeLlm`/`resolveLlm`.

The subagent does NOT self-classify completeness or route tools — that is the
Coordinator's + Planner's job (§6). The subagent just runs its delegated prompt and
returns its output.

## 6. Contexts + session model

All state is **per-session DATA in RAG**, hydrated into a light in-memory bundle at
request start and persisted back; code + endpoints are stateless.

**Three context layers (per-session):**
- **Clean global context** (Coordinator-owned) — the **ground-truth**: the target
  state + the objective record (actual results/artifacts in session-memory). Not an
  interpretation. The Planner cross-references it to detect drift / goal-distance.
- **Planner-private context** (Planner owns the shape; Coordinator persists it
  opaquely) — process-tracking + change-log. Re-fed to the Planner each call.
- **Executor context** — the per-step working context the Coordinator injects
  (step instructions + RAG/memory enrichment for that step).

**Session-memory** — a **separate, DURABLE per-session store** (a
KnowledgeRag-style backend, e.g. the JSONL knowledge backend, keyed by
`(userKey, sessionId)` — see Bundle key below). The Coordinator writes objective artifacts with
`{ type, name, source }` metadata so they are retrievable by natural language
("code of report X / its includes") and re-injected when a step needs them. It
behaves like an episodic memory: write salient items during the work, recall
relevant items into the next call's context.

> **Persistence target + split lifecycle (review — critical).** The session bundle
> (session-memory + planner-private context + budgets + pending-marker) persists in a
> durable backend (the JSONL knowledge backend, or a dedicated durable namespace)
> keyed by `(userKey, sessionId)` — NOT a `ragRegistry` `scope: session` collection
> (those are transient: `SessionGraph.dispose()` → `ragRegistry.closeSession` drops
> them, which would break a pending suspend/resume). The lifecycle is **split**:
> - **Survive:** idle eviction + reconfigure (transient graph teardown — the bundle
>   MUST outlive them so resume works across requests).
> - **Purge:** explicit `DELETE /v1/sessions/:id`, **goal completion**, and **TTL**
>   expiry. The server's session-delete path already purges the durable
>   knowledge-backend entries for that session (`smart-server.ts` ~2625); the
>   controller bundle living in that backend is cleaned by the SAME path — so DELETE
>   removes stale/private controller state too. (Do NOT let the bundle survive an
>   explicit delete.) Goal-complete + a goal-scoped TTL add cleanup for abandoned
>   sessions.

> **Bundle key (review).** `userKey = ctx.options?.userId ?? sessionId`. The default
> (non-auth) session resolver has only `sessionId` (`userId` is an optional
> `CallOptions.userId`), so `userKey` **collapses to `sessionId`** (effectively
> session-scoped). An auth-enabled downstream build supplies a real `userId`,
> enabling user-scope recall across a user's sessions. The bundle is keyed by
> `(userKey, sessionId)`; session-scope is always loaded, user-scope only when a real
> `userId` is present.

**Session = light, durably-persisted bundle, not a heavy/live session.** Lifecycle:
1. **Hydrate** — on a request, by `(userKey, sessionId)`, pull the user-scope (when
   present) + session-scope data from the durable store into the in-memory bundle
   (clean-global, planner-private, executor-ctx, budgets, pending-marker).
2. **Use** — the loop runs over the bundle within one request.
3. **Persist** — write deltas back to the durable store (survives graph dispose).
4. **Discard** — drop the in-memory bundle; the next request re-hydrates.

**Isolation by construction:** state is data namespaced by `(userKey, sessionId)`; code
and endpoints are stateless; nothing cross-session is held in memory. Isolation can
only break if code violates this principle (holds cross-session state) — which the
design forbids. Reuses the v19 per-session model (sessionId-keyed RAG, session graph,
dispose) for the EPHEMERAL graph, but the bundle's durable store outlives it.

## 7. Target-state establishment (Evaluator)

The Planner needs a crisp **target state** to plan toward and to detect completion.
The Evaluator establishes it from the prompt + clean global, with a configurable
strategy:

| `targetState.strategy` | How |
|---|---|
| `consumer-confirm` | Evaluator formulates the target state → Coordinator escalates (clarify round-trip, §10): "target = X; confirm/refine?" → confirmed state. |
| `semantic-distance` | Evaluator formulates → Coordinator (deterministic, via embedder) measures cosine distance between the target state and the original prompt; `≤ distanceThreshold` → proceed autonomously; `>` → escalate as ambiguous. |
| `auto` | The Evaluator decides which to apply (judges its own confidence). |

Split: **formulation** is the Evaluator (LLM); **distance measurement** and the
**confirm escalation** are deterministic Coordinator mechanics (embedder + §10). The
validated target state is stored in the **clean global** as the completion anchor.
It is stable; re-established only via escalation if the goal itself was
fundamentally misunderstood (a rewind-to-goal). This is the original "prompt
evaluation" responsibility, realized as a goal-establishment phase.

## 8. The control loop

Within one consumer request:
1. **Hydrate** the session bundle from RAG.
2. **Evaluator** → establish/validate the target state (§7); store in clean global.
   (May escalate per strategy → §10.)
3. **Planner** → given (planner-private + clean global + target state): `next-step`,
   `done`, or `rewind`.
4. `done` → **finalize** → return result; persist.
5. else **Executor** → execute `<next-step>` with Coordinator-injected context.
6. Executor returns:
   - `tool_call` → Coordinator routes: **internal** (`callMcp`, execute, feed back)
     or **external** (escalate via `ext:` round-trip, §10).
   - `error` → feed to Planner → re-plan (retry / rewind / escalate).
   - `content` → **memorizer** writes the result/artifact to session-memory (clean
     global).
7. Back to step 3 — the Planner **observes** the updated clean global and decides
   `next-step | done | rewind`. Bounded by `maxSteps`.

**Incremental planning subsumes back-edges and need-more:**
- "Go back to the spec" = the Planner simply returns `rewind` / a next-step like
  "redo spec" — no fixed plan with explicit back-edges.
- "Executor needs the includes" = the Planner's next step becomes "fetch includes of
  ZTEST", which the need-resolver fulfills — no separate `need-more` signal.
- **Review = the Planner's per-iteration observation** (it sees every executor
  result and judges progress vs the target state). No separate quality-gate
  round-trip; the Planner-Reviewer can decide "that step is bad → rewind/retry".

## 9. Tool routing

The Executor's `tool_call` is classified by the Coordinator:
- **Internal** = MCP tools (via `ctx.callMcp`) + RAG. The Coordinator executes and
  feeds the result back to the Executor in the next turn.
- **External** = consumer-provided tools, surfaced via the v19 external-tool
  round-trip (`ext:` content-addressed ids). The Coordinator escalates (§10).

## 10. Escalation + suspend/resume (stateless, via persisted data)

The loop runs within one request. Two escalation triggers: an **external tool**
(consumer-executed) and a **clarification / missing info** (not in RAG/MCP, e.g.
consumer-confirm of the target state). Both use a **data-persisted suspend/resume**
(no in-memory continuation → isolation preserved):
**External tool** — MUST integrate with the v19 `ext:` history-based protocol, not a
custom result channel:
- **Suspend:** the Coordinator **yields a standard `toolCalls` + `finishReason:
  'tool_calls'`** (the v19 surfacing; the `ext:` id is `externalToolCallId(name,args)`)
  and writes a **pending-marker** `{ kind: 'external-tool', toolName, args, extId,
  position }` + the contexts into the durable bundle; the request ends.
- **Resume:** on the next request the **incoming history carries the matched pair**
  `assistant(tool_calls=[ext:id]) → tool(tool_call_id=ext:id)`; the pipeline builds
  **`ctx.externalResults`** via `buildExternalResults` (adjacency-validated, history
  sanitized). The Coordinator **reads the result from `ctx.externalResults`**,
  correlates it to the pending-marker by `extId` → its `position`, feeds it onward,
  clears the marker. (It does NOT invent a separate "incoming tool result" path —
  the v19 adapter/history validation stays the single source.)

**Clarification / missing info** — separate path: the marker is
`{ kind: 'clarify', question, position }`; the Coordinator returns clarify content
(via `ClarifySignal`); the answer arrives as **new user input** on the next request
(not `externalResults`) and the marker correlates it to the parked position.

Both are **hydrate-and-continue from persisted state**, not a full re-run, and not a
held in-memory continuation. Reuses the v19 `ext:` mechanism (`externalToolCallId`,
`buildExternalResults`, adjacency validation, history sanitization) + `ClarifySignal`.

## 11. need-resolver + memorizer (deterministic Coordinator helpers)

- **need-resolver** — when a step references information ("fetch X"), a
  **deterministic semantic search** over the RAG namespaces (session-memory +
  tools-RAG + knowledge): artifact found → inject into the Executor context; tool
  needed → the Executor emits the `tool_call` next turn (Coordinator routes); nothing
  found → hand to the Planner (re-plan / escalate). Not an LLM.
- **memorizer** — the Coordinator writes the objective result/artifact of a step into
  session-memory with `{ type, name, source }` (type/name from the Planner's step
  spec). A distilling memorizer-subagent is deferred; MVP stores step results as-is
  with metadata. The Planner manages its own private context (emitted by the Planner,
  persisted opaquely by the Coordinator).

## 12. Error handling + budgets (persisted per-goal)

- `maxSteps` — total planner↔executor iterations per goal; a **persisted counter** in
  the bundle (accumulates across escalation round-trips, not reset per request).
- `maxRetries` — executor failures per step before handing to the Planner.
- `maxRewinds` — bounded re-planning / back-steps (prevents infinite replanning).
- Budget exhaustion → escalate to the consumer ("couldn't complete within budget;
  here is what I have / what I need").

## 13. Reuse vs new

**Reuse (no duplication):** the plugin contract (`IPipelinePlugin`/`IPipelineInstance`/
`IServerPipelineContext`/`createAgentBuilder`/`withStepperCoordinator`); knowledge-RAG
+ per-session hydration; the `ext:` external round-trip + `ClarifySignal`; **outbound
`ILlm`** (OpenAI/Anthropic providers, resolved via `ctx.makeLlm`/`resolveLlm`) for
subagent clients — NOT `ILlmApiAdapter` (that is the inbound server-API layer);
`callMcp`; the embedder (for semantic-distance). The durable bundle store reuses a
KnowledgeRag-style backend (JSONL) that outlives `SessionGraph.dispose()`.

**New (concentrated in the Coordinator):**

| File (`packages/llm-agent-server-libs/src/`) | Responsibility |
|---|---|
| `pipelines/controller.ts` | `ControllerPipelinePlugin` — `parseConfig` + `build` |
| `smart-agent/controller/controller-coordinator-handler.ts` | the deterministic loop (`IStageHandler`): hydrate → evaluator → loop[planner→executor→route→memorize→observe] → finalize → persist/escalate |
| `smart-agent/controller/session-bundle.ts` | hydrate/persist the per-session bundle over a DURABLE store (JSONL knowledge backend) that outlives `SessionGraph.dispose()` — NOT a ragRegistry `scope:session` collection |
| `smart-agent/controller/subagent-client.ts` | role-endpoint client over outbound `ILlm` (via `ctx.makeLlm`/`resolveLlm`); normalizes `content|tool_call|error` |
| `smart-agent/controller/target-state.ts` | Evaluator strategies (formulate[LLM] + distance[embedder] + confirm[escalation]) |
| `smart-agent/controller/need-resolver.ts` | deterministic RAG/MCP search for a referenced need |
| `smart-agent/controller/memorizer.ts` | deterministic artifact write to session-memory |

Relationship to `stepper`: reuses the **coordinator-handler pattern** (like
`StepperCoordinatorHandler`) but is a **distinct handler** — stepper is neither
touched nor extended.

## 14. YAML config

```yaml
pipeline:
  name: controller
  config:
    subagents:
      evaluator: { provider: openai, url: …, model: … }   # target-state
      planner:   { provider: openai, url: …, model: … }   # incremental next-step + review
      executor:  { provider: openai, url: …, model: … }    # may = planner endpoint in MVP
    targetState:
      strategy: auto            # consumer-confirm | semantic-distance | auto
      distanceThreshold: 0.25   # for semantic-distance
    sessionMemory:
      collection: session-memory
    budgets:
      maxSteps: 20
      maxRetries: 3
      maxRewinds: 5
```

Top-level `llm:`/`mcp:`/`rag:`/`subagents:` (server infra) unchanged.

## 15. Testing (hermetic)

- **Unit** — the Coordinator loop with **stub subagent clients** (scripted
  `next-step/done/tool_call/error/target-state`): assert the
  evaluator→loop[planner→executor→record→observe] flow; `done` detection; `rewind`;
  tool routing (internal stub `callMcp` / external `ext:` surfacing); budget
  exhaustion → escalate; the **hydrate → suspend → re-hydrate → resume** round-trip
  (pending-marker correlation); target-state strategies (consumer-confirm escalation,
  semantic-distance threshold with a stub embedder).
- **Conformance** — `parseConfig → build → streamProcess → close` against the plugin
  contract; the controller appears in the registry conformance test.
- No live endpoints (stub adapters + stub embedder/MCP).

## 16. MVP scope + future

**MVP:** Coordinator + the three subagent roles (`evaluator`, `planner`, `executor`,
which may share an endpoint) + the incremental loop + session-memory + target-state
(strategy configurable) + internal/external tool routing + stateless suspend/resume +
budgets. The dialog with the consumer and tool-routing are concentrated in the
Coordinator.

**Future:** distinct endpoints per role / role specialization beyond the three; a
distilling memorizer-subagent; richer drift metrics; parallel sub-step execution.
