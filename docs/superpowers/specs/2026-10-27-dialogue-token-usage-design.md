# Dialogue token usage — design

## Intent

Every answer reports the tokens it cost. A worker run directly reports its own usage. A dialogue
(planner + background workers) reports, on every planner message, the planner's own usage for that
turn and the usage of each worker task whose result the turn consumed, so a consumer can return a
total and a per-subagent breakdown. Usage records written through `IUsageRecorder` keep the
originating request's context for event-triggered turns.

## Goals

1. `ISubAgentResult.usage` carries per-model detail: `SmartAgentSubAgent.run` keeps `models` from the
   SmartAgent result instead of dropping it.
2. `TaskRecord.usage?: TokenUsage` — `TaskBoard` copies the worker result's usage onto the task record
   when a run returns (done, failed with a result, stopped with a result). Restored records keep it.
3. `PlannerAgent.process` may return `usage?: TokenUsage` next to `content`. `DialogueSession.turn`
   sums the usage of every planner call in the turn (corrective turns included).
4. `PlannerMessage.usage?: PlannerMessageUsage`:
   ```ts
   interface PlannerMessageUsage {
     planner?: TokenUsage;                 // sum of this turn's planner calls
     tasks?: Array<{ id: string; worker: string; usage: TokenUsage }>; // tasks whose terminal events this turn consumed
   }
   ```
   A user turn has `tasks` only if it consumed task events; an event turn lists each consumed task
   that has `usage`. Absent usage stays absent (no zero-filling).
5. Event turns keep the request context. `TaskBoard` remembers, per task, the recorder that was
   current when the task started (the turn's recorder, before `taskId`/`role` are added).
   `DialogueSession` builds an event turn's recorder from the first consumed event's origin
   recorder that exists (then `opts.usage`, then `board.usage`), plus a fresh `turnId`.
   The origin map is in memory only; after a restore event turns fall back to `opts.usage`.
6. Roles are not overwritten. The tool-loop paths (`pass-through.ts`, `tool-loop.ts`,
   `tool-loop-core.ts`, `mixed-tool-call-handler.ts`) stop setting `role: 'tool-loop'` and set the
   label `component: 'tool-loop'` instead, so the caller's role (`planner`, `executor`, …) survives.

## Types (in `@mcp-abap-adt/llm-agent`)

```ts
export interface TokenUsage extends LlmUsage {
  models?: Record<string, ModelUsageEntry>;
}
```
`ISubAgentResult.usage` becomes `TokenUsage` (structurally compatible). Export `TokenUsage` and
`PlannerMessageUsage` from the package index. Summing helper `addTokenUsage(a?, b?): TokenUsage |
undefined` in llm-agent (sums totals and per-model entries incl. `requests`; returns `undefined`
when both are absent).

## Non-goals

- No cached-token accounting (providers do not expose it through `LlmUsage` yet).
- No change to usage record schema or sinks.
- No persistence of origin recorders.

## Constraints

- Static typing: no `any`, no `unknown` outside caught errors, no `as unknown as`, no silencing casts,
  no untyped callback params — product code and tests.
- Changesets: minor bumps for `@mcp-abap-adt/llm-agent` and `@mcp-abap-adt/llm-agent-libs`.
- Recording and usage summing never affect execution (keep existing try/catch discipline).
