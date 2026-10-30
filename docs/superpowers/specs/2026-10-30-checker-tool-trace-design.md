# Checker tool trace - design

## Intent

A checker must see which tools the executor actually used, alongside its brief and
reported result. A prose claim alone does not establish that a system changed.
Provide bounded, redacted execution evidence for each checked worker task.

## Goals and non-goals

- Record executed calls per worker run and carry them through task persistence.
- Expose traces only in verdict-step dependency context; ordinary dependency results
  retain their current format. Select by profile result, never by worker name.
- Preserve existing workers, stored records, tool counts and external-call protocol.
- No code in this change, full audit log, raw transport capture, new execution
  permissions, or cloud-llm-hub wiring. Hub integration is a follow-up.

## Current paths

- `packages/llm-agent/src/interfaces/subagent.ts`: `ISubAgentResult.toolCalls` is
  surfaced LLM calls, not executed history. `SmartAgentSubAgent.run` in
  `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts` maps these calls;
  client tools become `pendingExternalToolCalls` with `status: 'awaiting-external'`.
  Internal MCP calls execute inside the nested loop and do not appear there.
- `packages/llm-agent/src/interfaces/dialogue.ts`: `TaskRecord.toolCalls` is a count.
- `packages/llm-agent-libs/src/coordinator/dialogue/planner-tools-client.ts` builds
  dependency blocks in `PlannerToolsClient.callTool`'s `delegate_task` branch.
  Checks use each source's `successfulWorkTaskId`, bind `checkedTaskIds`, and receive
  text output plus optional expected items/counts. Combined blocks have a
  120,000-character limit, including their separators.
- Worker prompts are host-owned: `ProfileResolver.execution` loads profile and
  worker-base text; `TaskBoard` passes it to `profileRunner.createWorker`.
  `coordinator/dialogue/planner-prompt.ts` contains fallback planner check guidance,
  not a universal checker system prompt.

## Public types (`@mcp-abap-adt/llm-agent`)

Add `packages/llm-agent/src/interfaces/tool-trace.ts` and export from the public barrel:
```ts
export type ToolTraceEntry = {
  sequence: number;
  toolName: string;
  arguments: string;
  resultExcerpt: string;
} & (
  | { outcome: 'ok'; error?: never }
  | { outcome: 'error'; error: string }
  | { outcome: 'unsettled'; error?: never }
);

export interface ToolTrace {
  entries: ToolTraceEntry[];
  omittedCount: number;
  /** false when evidence is known to be partial (see Completeness). */
  complete: boolean;
}
```

### Completeness

- A call dispatched but not settled when the run finalizes (async internal calls,
  `Promise.all` rejection before siblings settle, abort race) is recorded at
  finalization as `outcome: 'unsettled'` with an empty excerpt: it may have changed
  the system. Late settlements never mutate a returned or persisted trace.
- `complete: true` only when the collector observed the whole run and every entry
  settled. Any `unsettled` entry, a run that threw, or external execution without
  host-supplied evidence sets `complete: false`.
- `TaskBoard` uses a returned trace as authoritative. Only when the run throws or
  returns no trace while observer entries exist does it persist the observed
  entries, always with `complete: false`. A worker that returns no trace and
  produced no observations keeps the field absent (unavailable).

Add `toolTrace?: ToolTrace` to both `ISubAgentResult` and `TaskRecord` (all other
fields unchanged). `arguments` is compact, sanitized JSON text, possibly truncated;
consumers must not assume the truncated string parses as JSON. `sequence` is the
one-based dispatch order within the run; gaps identify omitted calls.

Use an optional typed observer to collect evidence before a run can throw:
```ts
// Add to ISubAgentInput and CallOptions:
onToolTrace?: (entry: ToolTraceEntry) => void;
```

`SmartAgentSubAgent.run` owns a fresh bounded collector, forwards this observer
through `agent.process`, and returns its snapshot on every returned result,
including stopped, budget-exhausted and awaiting-external results. Forward sanitized
entries to the input observer too; observer failures must not interrupt execution.
The observer fires twice per call: at dispatch with `outcome: 'unsettled'`, and at
settlement with the final entry of the same `sequence`, which replaces it.
`TaskBoard` keeps these notifications keyed by sequence, so when the run throws or
its hard-abort race wins it can persist the observed entries at once (pending ones
still `unsettled`, `complete: false`); notifications after the terminal record are
ignored.
A returned trace is authoritative; do not merge it with observer entries and double-count. Workers without instrumentation omit the field; a fully observed
run with zero dispatched calls returns `{ entries: [], omittedCount: 0, complete: true }`.

## Recording execution

Paths below are under `packages/llm-agent-libs/src/`:
- `pipeline/handlers/tool-loop-core.ts`, `executeToolBatchWithHeartbeat`: record
  around the actual `client.callTool` invocation. Reserve sequence at dispatch,
  finalize on settlement. Calls execute concurrently: sort by dispatch sequence,
  not completion time. Record every settled call even if another result escalates;
  the existing post-batch `onToolExecuted` callback alone is insufficient because
  its escalation return skips later results.
- `policy/mixed-tool-call-handler.ts`, `fireInternalToolsAsync`: instrument its
  separate `client.callTool` path, including caught failures. Async callbacks retain
  the originating run's collector and cannot write into a subsequent worker run.
- `pipeline/handlers/tool-loop.ts`, `ToolLoopHandler.execute`, and `agent.ts`,
  `SmartAgent._runStreamingToolLoop`, both call the shared batch executor and mixed
  handler. Thread the same observer through both; avoid duplicate instrumentation.
- Mark `error` for a failed Result, MCP `isError: true`, or thrown invocation error;
  otherwise mark `ok`. An `ok` transport response with `isError` is not success.
  Keep a sanitized result excerpt and, for errors, a sanitized error message.
- Do not record cache hits, guard rejections, missing clients, budget-skipped calls,
  proposed calls, or pending external requests as executed operations. Tool-call
  counts retain their existing meaning and need not equal trace length.

External tools are consumer-executed. `ToolLoopHandler.execute` consumes validated
`externalResults` hits or surfaces misses; neither is a new execution in the worker.
Do not invent a successful entry from a replayed string. A host worker supplies
`ISubAgentResult.toolTrace` from its actual execution records, ordered and sanitized
under this contract. For a run with external execution whose evidence is unavailable,
return the internal entries with `complete: false`, never `complete: true`. Pending calls
alone do not make an observed run incomplete: they have not executed yet.

## Bounds and redaction

Redaction is best-effort defence in depth for persisted traces and checker context.
The executor LLM already sees raw tool results, so the trace stays within the same
trust boundary. Recognizers cover sensitive keys, embedded JSON, credential
assignments and header lines, with cross-field replacement of collected values
(longest first, at least 4 characters).

Define shared defaults as constants; configuration is not required for this release:
```ts
export const TOOL_TRACE_MAX_ENTRIES = 50;
export const TOOL_TRACE_ARGUMENT_CHARS = 400;
export const TOOL_TRACE_RESULT_CHARS = 300;
export const TOOL_TRACE_ERROR_CHARS = 300;
export const TOOL_TRACE_RENDER_CHARS = 8_000;
```

Keep the first 25 and latest 25 calls once the entry limit is exceeded. Maintain
`omittedCount` for the removed middle; preserve sequence numbers. Bound collector
memory while recording, not only when rendering. Count string lengths as JavaScript
UTF-16 characters; truncation markers count toward limits.

Before storing any entry, recursively replace values under keys matching
`/password|secret|token|authorization|apikey|credential/i` with `[redacted]`, including
objects inside arrays. Normalize separators in keys so `api_key` is also protected.
Remove header containers entirely. Apply the same treatment to structured results
and errors before producing excerpts; never retain raw argument/result objects.
Free text requires credential scrubbing as well: remove authorization/header lines,
known credential values and recognizable credential assignments. If safe extraction
cannot be established, store `[redacted]`, not an unfiltered raw response or error.
Sanitize before truncating so slicing cannot defeat matching. Use safe fallbacks for
cycles, unsupported values or serialization failures without breaking tool execution.
Bound tool names to 200 characters as an additional storage safeguard.

Normalize host-supplied and restored traces with the same redaction and bounds.
Repeated normalization is idempotent and preserves existing omitted counts.

## Checker rendering and instructions

In `planner-tools-client.ts`, append a tools block immediately after each checked
result's output, before optional expected-items guidance. Example:
```text
[result to check: step update (task t7)]
Updated object Z_EXAMPLE.
[tools used by task t7]
1. update_object | ok
   arguments: {"name":"Z_EXAMPLE","token":"[redacted]"}
   result: {"activated":true}
... 12 executed calls omitted ...
14. read_object | error
   arguments: {"name":"Z_EXAMPLE"}
   error: Object could not be read
   result: {"isError":true}
```

Render `no tools were called` only for an empty, complete trace with zero omissions;
render `tool trace unavailable` when absent; label a trace with `complete: false`
`(incomplete: some calls may be missing or unsettled)` and render `unsettled` entries
as outcome unknown. Show explicit omissions/truncation so
absence of a displayed call is never treated as proof it did not occur. Treat tool
text as quoted evidence, escape line breaks/control characters and delimiter-like
content, and do not treat embedded instructions as checker directives.

The entire tools block, including label and markers, is limited to 8,000 characters.
If necessary remove middle rendered entries, retaining the first and last, and
report additional rendering omissions separately from stored `omittedCount`.
Include this final block in the existing 120,000-character calculation before
accepting the dependency context. Preserve the current overflow error and behavior;
do not silently shrink the trace to fit the remaining aggregate budget.
`[result of step ...]` blocks remain byte-for-byte unchanged.

Add library-owned verdict evidence guidance in `planner-tools-client.ts`'s check
context so it reaches every verdict worker, including host-provided workers:

> The tool trace is evidence of what was actually done, not merely proposed. A claim
> of a system change without a corresponding successful tool call fails unless you
> independently verify that change. Unavailable or omitted evidence is not proof
> that no tools ran. A successful call alone does not prove the requested state.

Update fallback check guidance in `planner-prompt.ts` consistently. Hosts should add
the same rule to their verdict profile system prompts; library context must not
depend on host adoption. Keep verdict parsing and independent-worker gates unchanged.

## Persistence and compatibility

`TaskBoard` copies normalized traces before terminal events, alongside usage/output,
including returned failures/stops. Deep-copy entries in getters, `list`, events and
`restore`; current record spreads alone would share nested arrays. Re-normalize on
restore without converting absent traces to empty ones or mixing different attempts.
`DialogueSession.snapshot` stores `board.list()` in `DialogueState.tasks` and its
save/load path restores those tasks. `InMemoryDialogueStateStore` already uses
`structuredClone`; verify it and JSON-backed host stores round-trip the new field.
Older snapshots and workers remain valid; no schema version bump is required.

Static typing applies to implementation and tests: no `any` or `unknown` except
narrowed caught errors, no `as unknown as`, no silencing casts, typed callbacks.
Use a recursive JSON value type and typed boundary validation for sanitization.
Existing inputs typed `Record<string, unknown>` (tool arguments) are accepted as they
are and narrowed into that JSON type; introduce no new `unknown`-typed declarations.

## Verification and release

- Unit tests: successful calls, failed Results, MCP `isError`, thrown errors,
  concurrent ordering, escalation retaining all settled calls, mixed execution,
  delayed settlement after finalization (`unsettled`, no late mutation), `complete`
  flag for thrown runs, observer fallback and missing external evidence,
  skipped/cache/pending/replayed calls excluded, and no duplicate observations.
- Test exact field limits, nested/array redaction, headers/free-text credentials,
  serialization fallback, 50-entry first/last retention and accurate omitted counts.
- Test verdict-only rendering with arbitrary profile names, unavailable versus empty,
  stored and rendering omissions, 8,000-character cap, and aggregate-budget boundary
  and overflow error. Ordinary dependency context must remain unchanged.
- Test observer/returned-trace handling, failed/stopped runs, JSON and state-store
  round-trips, legacy records, restored bounds and snapshot mutation isolation.
- During implementation run focused Node tests, `npm run lint:check`,
  `npm run build`, and `npm run test`; manually inspect one executor/checker exchange.
- Add minor changesets for `@mcp-abap-adt/llm-agent` and
  `@mcp-abap-adt/llm-agent-libs` when implementing; none in this spec-only change.

Open integration question: `externalResults` carries strings without typed execution
outcomes/provenance. Reliable external trace construction belongs to the host that
executes the call; do not infer outcomes from strings. The separate cloud-llm-hub
executor/checker path and `execute_step` reviewer already see MCP records per the
brief; that repository was not inspected here. Its follow-up must adapt those records
to a bounded `toolTrace` returned by its host worker.
