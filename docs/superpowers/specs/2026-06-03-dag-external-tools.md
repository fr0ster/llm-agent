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
5. **Stateless coordinator.** No persisted continuation / resume token. On resume (the client's next request with the tool results in history) the DAG re-runs; the **per-session knowledge-RAG blackboard + cross-step dedup (18.1)** short-circuits already-completed work (e.g. the review), so the executors that were awaiting external results pick them up from the message history and finish. The coordinator stores nothing after responding.

## Why a "pause" exists at all

A single sequential executor could use pure stateless round-trips with no special handling. The pause/collect is needed ONLY because the planner can spawn **parallel executors**: when one emits an external tool_call we must not lose the others' progress. The barrier is: let each parallel executor run until it either (a) finishes its internal work (written to the session knowledge store) or (b) emits an external tool_call (collected into the queue); then the coordinator ends the turn with the collected external tool_calls.

## Mechanism (implementation outline)

- **tool-loop.ts:** drop `mode==='hard' ? []` — always include `ctx.externalTools`. When the worker LLM emits a tool_call whose name ∈ externalToolNames, DO NOT execute it server-side; mark it as a pending external call and surface it upward (it already partially does this — `externalToolIndices` / external delta yield at ~455-467; finalize that path so an external tool_call ends the worker turn with the call rather than looping).
- **DAG interpreter / coordinator:** collect external tool_calls emitted by (possibly parallel) worker nodes into a FIFO queue; when the barrier settles, emit them as the coordinator's terminal assistant turn (`finish_reason: tool_calls` with all collected calls, correlation-preserved). Nodes that finished internal work have written their artefacts to the session knowledge store (resume short-circuit).
- **Resume:** the client's follow-up request carries the prior assistant tool_calls + the `role:"tool"` results. The DAG re-runs; planner + session-knowledge dedup skip completed nodes; the executor that needed the external result reads it from history and continues. No server state.
- **Planner (#171 obs. 2c):** allow a "call external tool X" objective to route to a worker (or a thin external-tool node) so a bare external-tool request does not return `(no response)`.

## Open implementation questions (resolve during build)

- Exact barrier semantics when parallel executors mix internal-only and external-needing nodes (collect-all vs first-external-wins). Lean: let all parallel nodes reach a settle point, collect all external calls into one turn.
- How the resume re-run reliably maps a returned `tool_call_id` result back to the node that needs it (the message history carries it; the executor re-deriving its own pending call must match by id).
- Anthropic adapter ordering constraint (`tool_result` first, immediately after `tool_use`) when the coordinator composes the terminal turn.

## Out of scope

- No stateful continuation / resume tokens / session pinning.
- No new transport (WebSocket / side-channel) — standard OpenAI/Anthropic multi-turn only.
- Internal MCP tool behaviour and `mode` semantics for internal tools — unchanged.
