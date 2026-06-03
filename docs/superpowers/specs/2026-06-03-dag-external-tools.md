# DAG external (client-provided) tools — contract & design (#171)

**Status:** design, pre-implementation. **Issue:** #171.

## Problem

Every client forwards its **own MCP tools as external (consumer-executed) tools** in the request `tools[]` (the universal pattern — Cline, cloud-llm-hub, etc.). The flat SmartAgent handles them via standard tool-calling. Under the **DAG coordinator** they break:

- `mode: hard` worker DROPS external tools (`mode==='hard' ? [] : ctx.externalTools`) yet their names still **leak into the worker prompt** → the model says "rag_add is a Skill I can't call".
- `mode: smart` worker keeps them in `tools[]` but **never surfaces the external `tool_call`** (finishes `stop`); a bare "call external X" → planner makes no node → `(no response)`.

## Verified protocol (the transport — standard, not custom)

Tool-calling is the **standard OpenAI / Anthropic** round-trip; for the client it is one logical conversation (its agentic loop):

- **OpenAI:** model emits `finish_reason: "tool_calls"` + `message.tool_calls[]`; the API does NOT execute; client runs them, appends `role:"tool"` messages with `tool_call_id`, re-sends. **Parallel function calling is standard** — one assistant turn may carry MULTIPLE `tool_calls` run in parallel.
- **Anthropic:** `stop_reason: "tool_use"` + one-or-more `tool_use` blocks (each with `id`); client returns a `user` message whose `tool_result` blocks (`tool_use_id`) come FIRST and immediately follow the `tool_use` turn; loop while `stop_reason==tool_use`. Multiple `tool_use` blocks = parallel.

So there is **no in-run bidirectional channel** to build: the turn ends on tool_calls, the client executes and re-sends. Stateless across the round-trip.

## Contract (decided)

1. **External tools are mode-independent.** Mode (hard/smart) governs only INTERNAL (MCP) tool behaviour. External (client) tools are ALWAYS in the worker's `tools[]`, hard or smart. Remove the `mode==='hard' ? [] : ...` drop.
2. **The consumer owns external tools.** The worker NEVER executes an external tool; it emits the `tool_call` and surfaces it to the client, which executes and returns the result (standard round-trip).
3. **No prompt leak.** External tool names must not appear as un-callable "Skill" prose in the worker prompt when they are (wrongly) excluded — once (1) holds they are real entries in `tools[]`, so the leak path is removed with the drop.
4. **Parallelism via standard multi-tool turn.** When several parallel executors each want an external tool, the coordinator COLLECTS their external `tool_call`s into ONE assistant turn (FIFO-ordered, correct `tool_call_id`/`tool_use_id` correlation — "never mixed"), ends the turn (`finish_reason: tool_calls` / `stop_reason: tool_use`). The client executes all (in parallel) and re-sends all results.
5. **Stateless coordinator.** No persisted continuation / resume token. On resume (the client's next request with the tool results in history) the DAG re-runs; the **per-session knowledge-RAG blackboard + cross-step dedup (18.1)** short-circuits already-completed work (e.g. the review), so the executors that were awaiting external results pick them up from the message history and finish. The coordinator stores nothing after responding. The history↔re-run correlation is made concrete by **deterministic external tool_call ids — see D1** (this was the gap the review flagged; resolved below).

## Why a "pause" exists at all

A single sequential executor could use pure stateless round-trips with no special handling. The pause/collect is needed ONLY because the planner can spawn **parallel executors**: when one emits an external tool_call we must not lose the others' progress. The barrier is: let each parallel executor run until it either (a) finishes its internal work (written to the session knowledge store) or (b) emits an external tool_call (collected into the queue); then the coordinator ends the turn with the collected external tool_calls.

## Mechanism (implementation outline)

- **tool-loop.ts:** drop `mode==='hard' ? []` — always include `ctx.externalTools`. When the worker LLM emits a tool_call whose name ∈ externalToolNames, DO NOT execute it server-side; mark it as a pending external call and surface it upward (it already partially does this — `externalToolIndices` / external delta yield at ~455-467; finalize that path so an external tool_call ends the worker turn with the call rather than looping).
- **DAG interpreter / coordinator:** collect external tool_calls emitted by (possibly parallel) worker nodes into a FIFO queue; when the barrier settles, emit them as the coordinator's terminal assistant turn (`finish_reason: tool_calls` with all collected calls, correlation-preserved). Nodes that finished internal work have written their artefacts to the session knowledge store (resume short-circuit).
- **Resume:** the client's follow-up request carries the prior assistant tool_calls + the `role:"tool"` results. The DAG re-runs; planner + session-knowledge dedup skip completed nodes; the executor that needed the external result reads it from history **by deterministic `extId` (D1)** and continues without re-surfacing. No server state.
- **Planner (#171 obs. 2c):** allow a "call external tool X" objective to route to a worker (or a thin external-tool node) so a bare external-tool request does not return `(no response)`.

## Resolved design decisions (review findings)

### D1 — `tool_call_id` correlation on stateless re-run (was High open Q)

The risk: turn 1 ends with an assistant tool_call id `call_X`; the client returns a `role:tool` result bound to `call_X`. On the stateless re-run the worker LLM would mint a NEW id (`call_Y`) and the result no longer matches.

**Decision — deterministic synthetic ids.** External tool_call ids are NOT the LLM's random ids; the coordinator/executor REWRITES each surfaced external call to a deterministic id:

```
extId = `ext:${nodeId}:${artifactIdentityKey(toolName, args)}`
```

reusing the existing `stableArgsKey` / `artifactIdentityKey` (18.1, `packages/llm-agent/src/artifact-identity.ts`). Same node + tool + canonical args ⇒ same id across re-runs.

**Resume mechanism (concrete).** At request start the coordinator builds `externalResults: Map<extId, resultContent>` from the incoming history's `role:"tool"` / `tool_result` messages (keyed by their `tool_call_id` / `tool_use_id`, which carry the deterministic `extId` from the prior turn). This map is threaded down to executors. When an executor's LLM emits a call to an external tool:
1. compute `extId`;
2. if `externalResults.has(extId)` → inject that result as the tool message and CONTINUE the worker (no re-surface) — this is "picks up from history", made concrete;
3. else → rewrite the call's id to `extId`, mark the node `awaiting-external`, surface it (collected).

Determinism of args across re-runs is held by the **session-knowledge short-circuit**: upstream nodes (e.g. the review) are not recomputed — their artefacts are reused — so the inputs that produce the external call's args are stable, hence `extId` is stable. If args genuinely differ on re-run, the `extId` differs and it is correctly a NEW call (not a mismatch).

### D2 — typed "awaiting-external" path (was High open Q)

Add an explicit, typed outcome so the interpreter/coordinator have a stable API (no string sniffing):

- `ISubAgentResult` (`packages/llm-agent/src/interfaces/subagent.ts`): add
  `status?: 'complete' | 'awaiting-external'` (default `'complete'`) and
  `pendingExternalToolCalls?: LlmToolCall[]` (each carrying the deterministic `extId`). The existing `toolCalls?` stays for back-compat but the pending-external semantics live in these new fields.
- `NodeResult` (`interfaces/interpreter.ts`): extend `status` union with `'awaiting-external'`.
- `InterpretResult`: add `pendingExternalToolCalls?: LlmToolCall[]` — the FIFO-ordered aggregate across all `awaiting-external` nodes (correlation-preserved).
- **Coordinator branch:** if `InterpretResult.pendingExternalToolCalls?.length` → take the **no-finalizer** path: emit the terminal assistant turn carrying those calls (`finish_reason: 'tool_calls'` / `stop_reason: 'tool_use'`); do NOT run the finalizer. Else → finalizer as today. The DAG-coordinator handler already has a finalizer/yield split (#166) to hang this off.

### D3 — barrier semantics + abort (was Medium open Q)

**Decision — collect-all-at-settle.** Each parallel node runs to its settle point — `done | failed | skipped | awaiting-external`. The coordinator emits the terminal external-tool turn only after ALL currently-scheduled parallel nodes have settled; it never emits a partial turn mid-fan-out (this is the "never mixes the queue" guarantee). First-external-wins is rejected — it would orphan the other in-flight nodes' work, the exact problem the design exists to avoid.

**No special external-wait timeout.** Nodes do NOT block on the client: a node that needs an external tool reaches `awaiting-external` and ENDS its turn. So the only latency is the slowest still-running parallel node finishing its current LLM turn, already bounded by the existing per-node `maxIterations` + shared token budget + request abort signal. No new timeout primitive.

### D4 — `mode` semantics reconciliation (was Medium conflict)

ARCHITECTURE.md §"Key decision points" (1) currently says `hard` = "MCP-only tools (no external tools)". That conflated two things: (a) which tools the worker EXECUTES itself, and (b) which tools are OFFERED/surfaced. External (client) tools are **by definition consumer-executed** — the worker never executes them — so excluding them from `tools[]` only breaks surfacing without adding safety.

**Decision:** `mode` governs only the worker's INTERNAL execution posture (hard = the worker executes only its own MCP tools; smart = full orchestration with the internal-first priority instruction). **Client/external tools are always offered and their calls always surfaced, in every mode** (flat AND DAG, for consistency). Update ARCHITECTURE.md (1) to: *"`hard` forces the worker to execute only internal MCP tools; client/external tools are still offered and their calls surfaced to the consumer."* A future explicit `denyExternalTools` flag can cover the "lock out client tools entirely" posture if a deployment needs it — out of scope here.

## Docs to update on implementation

- `docs/ARCHITECTURE.md` decision point (1) — the `hard` reconciliation (D4).
- `docs/INTEGRATION.md` — a short "external/client tools under the coordinator" note (always available, consumer-executed, standard round-trip, deterministic ids).
- `scripts/integration/dag-coordinator-mcp/README.md` — extend the integration check to cover an external-tool round-trip once implemented.

## Out of scope

- No stateful continuation / resume tokens / session pinning.
- No new transport (WebSocket / side-channel) — standard OpenAI/Anthropic multi-turn only.
- Internal MCP tool behaviour and `mode` semantics for internal tools — unchanged.
