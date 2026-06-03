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

### D1 — `tool_call_id` correlation on stateless re-run (was High open Q; revised after review #2)

The risk: turn 1 ends with an assistant tool_call id `call_X`; the client returns a `role:tool` result bound to `call_X`. On the stateless re-run the worker LLM would mint a NEW id (`call_Y`) and the result no longer matches.

**Decision — CONTENT-ADDRESSED deterministic ids (no nodeId).** The coordinator/executor REWRITES each surfaced external call to a deterministic id derived ONLY from the call's content:

```
extId = `ext:${shortHash(identity)}`
        // identity = toolName  +  NUL-separator  +  deepStableArgsKey(args)
        //   (the separator is a NUL byte, written here textually — NOT embedded as a control byte)
        // shortHash         = first 16 hex chars of sha256(identity)
        // deepStableArgsKey = case-PRESERVING, DEEP canonical JSON (see the deep-canonicalization bullet below)
```

- **No `nodeId` in the id** (review-#2 High): planner node ids are LLM-generated and may change between re-runs, which would orphan the result. Content-addressing removes that dependency entirely — the id is a pure function of `(toolName, canonical args)`. This is consistent with the 18.1 artifact-identity dedup philosophy (same tool+args = same logical artefact/call). Two distinct nodes issuing the *identical* external call collapse to one id — acceptable and idempotent-consistent; per-node distinctness, if ever needed, would use a coordinator-assigned **canonical plan-order ordinal** (assigned at execution start, NOT the planner's raw LLM id) — out of scope unless a real case appears.
- **shortHash, not raw identity** (review-#2 Medium): never put the raw identity (which carries `JSON.stringify(args)` — quotes/braces/user data, possibly large) in a `tool_call_id` / `tool_use_id`. Hash it (16 hex). The full identity is kept in node metadata + the session log for debugging, never in protocol metadata.
- **Case-PRESERVING identity for external tools** (review-#3 non-blocking, adopted as a decision): do NOT reuse `artifactIdentityKey()` here — it lowercases the whole key, which is right for ABAP object-name dedup (`F01`≡`f01`) but WRONG for arbitrary client args (e.g. `rag_add(content:"Hello")` vs `"hello"` must NOT collapse). The external `extId` uses a case-PRESERVING canonical serializer WITHOUT the lowercase. **Test (required):** an external call differing only by argument case yields a DISTINCT `extId` (does not reuse the other's result).
- **DEEP canonicalization required** (review-#4 Medium): `stableArgsKey()` as shipped sorts only the TOP-LEVEL object keys (`packages/llm-agent/src/artifact-identity.ts:11` — nested objects/arrays are `JSON.stringify`-ed in their original key order). Arbitrary client tools plausibly take nested args, so `{filter:{a:1,b:2}}` vs `{filter:{b:2,a:1}}` would hash differently and BREAK stateless resume. The external `extId` MUST use a **deep** canonical JSON (`deepStableArgsKey`): recursively sort object keys at every depth, preserve array order (arrays are ordered). Implementation: either extend `stableArgsKey` to recurse (safe — flat-arg callers like the ABAP dedup are unaffected, deep≡shallow for flat objects) or add a dedicated `deepStableArgsKey` for the external-id path. **Test (required):** nested args differing only by key order yield the SAME `extId`.

**Resume mechanism (concrete) + adjacency validation (review-#2 Medium).** At request start the coordinator builds `externalResults: Map<extId, resultContent>` from the incoming history — but ONLY for results that satisfy protocol adjacency:
1. scan assistant turns for external tool_calls whose id matches the `ext:` shape;
2. accept a `role:"tool"` / `tool_result` message into the map ONLY if it **immediately follows** the assistant turn that DECLARED that id, and its `tool_call_id` / `tool_use_id` is one of that turn's declared external-call ids. This is the SAME strict adjacency invariant for BOTH providers (review-#3): OpenAI `assistant(tool_calls=[ext:…]) → tool(tool_call_id=ext:…) …` and Anthropic `assistant(tool_use id=ext:…) → user(tool_result tool_use_id=ext:… FIRST)`. "Any prior assistant external call" is REJECTED — it would swallow a stale/injected result placed elsewhere in history.
3. **Partial sets tolerated:** an assistant external turn may declare N ids; accept whichever of the N have an immediately-following matching result, and treat the rest as still-pending (they re-surface on this run). A tool-result that does NOT immediately follow its declaring assistant turn (orphan, mis-placed, or injected) is **rejected/ignored** — a malformed or over-eager client cannot inject arbitrary results into the map, even though external tools are consumer-owned.

**History sanitization — partial sets are protocol-safe because the raw external turns are NEVER replayed to a provider (review-#5 Medium).** A client history with `assistant(tool_calls=[a,b])` + only `tool(a)` is malformed for a provider continuation (OpenAI/Anthropic require a result for EVERY declared tool_call before the next turn) — so the coordinator MUST NOT forward those raw turns into any internal LLM call. Rule:
- The incoming client `assistant(external tool_calls)` turns and their `role:"tool"` / `tool_result` turns are **CONSUMED** into `externalResults` and **STRIPPED** from every message list passed to internal planner/worker LLM calls. Internal calls build FRESH conversations; an external result enters a worker's messages ONLY via the `extId` lookup below (so it is always paired with the matching re-emitted call → never an unmatched `tool_calls`).
- Therefore no provider-facing message list (planner, worker, or the coordinator's own composition) ever contains an unmatched assistant `tool_calls`/`tool_use`; the still-pending ids simply re-surface as a fresh, well-formed terminal turn. (If a deployment prefers strictness over tolerance, the alternative is to reject a partial history as `malformed_request` up-front — documented as the opt-out, not the default.)
- **Test (required):** assistant declares two `ext:*` calls; history contains exactly one adjacent result. The coordinator accepts that one, re-surfaces the missing one, AND assert that NO internal/provider-facing message list contains an unmatched assistant `tool_calls`/`tool_use`.

The validated map is threaded down to executors. When an executor's LLM emits a call to an external tool:
1. compute `extId`;
2. if `externalResults.has(extId)` → inject that result as the tool message and CONTINUE the worker (no re-surface) — "picks up from history", made concrete;
3. else → rewrite the call's id to `extId`, mark the node `awaiting-external`, surface it (collected).

Determinism of args across re-runs is held by the **session-knowledge short-circuit**: upstream nodes (e.g. the review) are not recomputed — their artefacts are reused — so the inputs that produce the external call's args are stable, hence `extId` is stable. If args genuinely differ on re-run, `extId` differs and it is correctly a NEW call (not a mismatch).

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
