# Agent profiles - design

## Intent

Worker functions need different instructions and tool access. New functions should be
host configuration, without a library release or prompt text embedded in llm-agent.
The planner chooses a function by name; semantic retrieval supplies skills and other
context for that step, not the identity of its worker.

The host owns every worker base, function prompt and planner prompt. It can store these
records in RAG and change them at runtime; repository files may seed that store, but
seeding, storage and editing are host concerns. Named profile lookup must be exact,
not a nearest-neighbour search. This design covers the mechanism only.

## Goals and non-goals

- Discover enabled worker profiles and let the planner choose by name and description.
- Resolve fresh instructions for each task and apply tool policy through a host hook.
- Replace the special worker name `checker` with `result: 'verdict'`, allowing several
  verification functions while preserving independent verification and delivery rules.
- Preserve existing workers-map hosts and persisted plans.
- No library-owned worker prompt catalogue, RAG backend, profile editor, new skill
  retrieval path, or automatic execution privileges. `DIALOGUE_PLANNER_SYSTEM` remains
  the fallback default only for hosts that supply no planner text.

## Contract (`@mcp-abap-adt/llm-agent`)

Add `packages/llm-agent/src/interfaces/agent-profile.ts`, exported from the public
barrel. Use the existing `Result<T, E>` from `interfaces/types.ts`:

```ts
export type WorkerToolPolicy =
  | 'all'
  | 'read-only'
  | { allow?: string[]; deny?: string[] };

export interface WorkerProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools: WorkerToolPolicy;
  result: 'report' | 'verdict';
}
export interface WorkerProfileSummary {
  name: string;
  description: string;
  result: WorkerProfile['result'];
}
export interface AgentProfileError {
  code: 'missing' | 'disabled' | 'unavailable' | 'invalid';
  message: string;
}
export interface IAgentProfileSource {
  list(options?: CallOptions): Promise<Result<WorkerProfileSummary[], AgentProfileError>>;
  get(name: string, options?: CallOptions): Promise<Result<WorkerProfile, AgentProfileError>>;
  getPrompts(options?: CallOptions): Promise<Result<{
    workerBase?: string;
    planner?: string;
  }, AgentProfileError>>;
}
export interface IAgentProfileRunner {
  createWorker(input: {
    profile: WorkerProfile;
    workerBase?: string;
  }, options?: CallOptions): Promise<Result<ISubAgent, AgentProfileError>>;
  preparePlanner(input: {
    systemPrompt: string;
  }, options?: CallOptions): Promise<Result<ISmartAgent, AgentProfileError>>;
}
```

`CallOptions`, `ISubAgent` and `ISmartAgent` above are existing public contracts.
`result` in the summary makes the role visible without fetching every full prompt.
Names are non-empty, unique, case-sensitive stable keys. `list()` returns enabled
profiles only; `get()` distinguishes missing from disabled records. Validate result
variants, policy shape, name equality and string fields at the library boundary;
invalid records fail rather than being silently repaired. Empty prompt strings are
valid explicit values; absent planner text alone selects the fallback.

Add paired optional `profileSource` and `profileRunner` to `TaskBoardOptions` and
`DialogueSessionOptions`; both are required together in profile mode. The session
passes these through its board integration; standalone boards support the same path.
Existing `workers` and `planner` options remain supported for legacy construction.
The host runner constructs a task-scoped worker and a planner for each planner call,
using its existing pipelines, providers and enforced tool ceilings. Reusable clients
are allowed; mutable per-task prompt or tool configuration must not be shared.
No new profile requires an entry in the legacy workers map.

## Resolution, discovery and failures

- Before every planner call, including corrective calls, call `list()` and
  `getPrompts()`. Put names, descriptions and result kinds in a `[worker profiles]`
  prepared-context note and in `delegate_task`'s description; use the names as its
  worker enum. Include the same discovery in conversation mode through the tool
  description. `PlannerToolsClient.cacheable = false` remains appropriate.
- Selection is explicit: `delegate_task.worker` must equal the structured step's
  assigned worker when present. An unassigned step binds its worker and result kind
  on first delegation. Validate the requested name against a fresh enabled listing
  and `get(name)` before queuing; the enum alone is not validation.
- At execution start, after acquiring the concurrency slot, call `get(name)` and
  `getPrompts()` again. This is authoritative: edits made while queued affect this
  task. If the result kind differs from the bound step kind, fail before execution
  and require reopening the step. Prompt and policy edits within that kind apply.
  Capture one immutable snapshot for the run; never change it during tool rounds.
- The library keeps no cross-call or cross-task profile cache (TTL zero); deduplicate
  only concurrent reads within one resolution. Host adapters must offer equivalent
  freshness: no positive TTL or stale-while-revalidate for these methods. Backends
  may cache immutable revisions only after checking the current revision/enablement
  on every lookup. Changes after execution starts apply to the next task.
- Default source deadline is 3 seconds per resolution, configurable as
  `profileTimeoutMs`, with the caller's cancellation signal. Throws, deadline expiry
  and rejected promises become `unavailable`; late completions are ignored.
- Missing/disabled/invalid profiles return a planner tool error naming the profile
  (for example `profile review is disabled`), without queuing or invoking a worker.
  A failure discovered at execution start fails that queued task and emits the normal
  failed event naming the profile. The planner can choose another enabled profile.
- With an explicit source, unavailability fails closed: no cached profile, legacy
  worker or hardcoded prompt substitutes for it. A failed listing/prompt read prevents
  that planner call and follows the existing failed-turn path, preserving state for
  retry. No-source legacy mode uses the compatibility adapter below. A successful
  prompt read with no planner text uses `DIALOGUE_PLANNER_SYSTEM`; an unavailable
  source is not the same as omitted text. Runner failures likewise execute nothing.

## Prompt composition

Worker assembly order is host worker base, then `profile.systemPrompt`, then
library-added parts. Static library protocol guidance, including
`REQUEST_TIME_GUIDANCE`, follows the host text, exactly once. The static prefix is
stable for an unchanged profile and base, supporting provider prompt caching.

Matched skills and extra prompt fragments still use the existing semantic skills
path for the step. Their placement follows the static prefix in request content,
with the brief, dependency results and formatted request-time line. They are not
inserted into the system message: a matched skill is request-dependent, so treating
all matched skill text as static per profile would invalidate the caching premise.
Only invariant library guidance belongs in the system suffix. No goal, retrieved
fragment, timestamp, or worker listing enters the system prompt.

The planner uses host planner text from `getPrompts()` when present, otherwise the
fallback, followed by invariant library protocol guidance without duplication.
`profileRunner.preparePlanner` applies this resolved text to a fresh call-scoped
planner. Custom host text replaces the fallback rather than being appended to it.
Tool validation remains authoritative regardless of what either prompt says.

Integration points are `context/context-assembler.ts`,
`subagent/direct-llm-subagent.ts`, and `coordinator/dialogue/planner-prompt.ts` under
`packages/llm-agent-libs/src/`. Preserve request timestamp propagation and the existing
skills retrieval pipeline; the host runner must route supplied prompt components
through this assembly rather than adding a second system prompt independently.

## Verification is a result kind

Add optional `result?: WorkerProfile['result']` to public `PlanStep`, `TaskRequest`
and `TaskRecord` in `packages/llm-agent/src/interfaces/dialogue.ts`. These are
library-resolved role snapshots, not model assertions. Structured plan input still
chooses `worker`; `update_plan` resolves its summary and binds `result`. An unassigned
step is an ordinary report step until bound; assigning a verdict worker requires an
explicit plan update. Events use the task snapshot, never a fresh profile lookup.
Multiple verdict profiles can coexist and can check different report workers.

All paths below are in `packages/llm-agent-libs/src/coordinator/dialogue/`:

| Current coupling | New rule |
| --- | --- |
| `planner-tools-client.ts:202-205`, step/dispatch checker-name comparison | Compare bound step result kind with resolved profile kind, and validate assigned name. Report steps cannot dispatch to verdict profiles or the reverse. |
| Same file, dependency forwarding and same-worker guard around line 229 | Verdict steps require dependencies with successful report task snapshots. Reject verdict-produced sources and any source produced by the checking worker name. Keep separate task IDs and invocation scopes: the doing worker never checks its own step. |
| Same file, labels, batch expectations and `checkedTaskIds` | Use verdict kind for `[result to check: ...]`, expected item IDs/counts and exact source bindings; report dependencies retain `[result of step ...]`. Preserve the 120,000-character aggregate limit and overflow errors. |
| `structured-plan.ts:97`, `mergePlan` role change | Compare bound result kinds, requiring pending/reopening and clearing evidence when kind or dependencies change. Changing an assigned worker name also requires reopening, including verdict-to-verdict changes; never transfer a passing result to a new function. Reject changes while an attempt is active. |
| `structured-plan.ts:307`, stale check events | Apply source-current validation to every verdict step; late events cannot restore invalidated evidence. |
| `structured-plan.ts:323`, source completion | Reset dependent verdict steps to pending, clear verdict and source bindings, and require fresh attempts when successful source task IDs change. |
| `structured-plan.ts:337`, failed task | A failed verdict attempt records fail on its own step, never on its source. Preserve stopped/interrupted and budget failure rules. |
| `structured-plan.ts:342`, verdict parsing | Parse only verdict tasks: existing PASS/FAIL or JSON verdict/count/note, including outermost fenced/prose candidates. Malformed or conflicting candidates, missing/short batch counts and unusable output fail. Report output is never parsed as a verdict. |
| `structured-plan.ts:380`, `deliveryChecksPassed` | Find dependent verdict steps across all profile names. Preserve current latest-check selection: require a source-current passing done latest check and no failed latest check; no checks still permits done work. |
| `dialogue-session.ts`, `deliver` handler | Keep ownership, current request, done-task and done-step gates, then call generalized delivery gating. Profile removal must not erase existing checks or bypass them. Preserve exact output and one delivery per planner call. |
| `task-board.ts`, registry/name validation and execution | Discover from source; resolve again at start; persist task result kind, pass policy unchanged to the host hook, and run its task-scoped agent. Preserve budgets, cancellation, usage, events and task identity. |
| `planner-prompt.ts`, delegate tool descriptions and error strings | Describe checks as independent verdict-profile steps, advertise profile descriptions, remove operational dependence on the literal checker name. Keep the fallback export for legacy hosts. |
| `interfaces/dialogue.ts`, state restore and snapshots | Persist role metadata with steps/tasks, verdicts, task links and checkedTaskIds. Restore roles without consulting mutable prompt records; preserve existing legacy check/checking normalization. |

A completed attempt retains its recorded kind even if a profile is later edited or
disabled. A new attempt cannot reinterpret it. A step kind change requires reopening
and invalidates downstream evidence just as a changed successful source does today.
Role restrictions remain scoped to structured plans; legacy text plans and unstructured
tasks retain delegation compatibility, with source availability and tool ceilings still
mandatory in profile mode.

## Compatibility and persisted state

Without `profileSource`, derive a default set from today's `workers` map: name and
existing description (or name if absent), empty additional system text, `tools: 'all'`,
and `result: 'verdict'` for `checker`, otherwise `report`. Empty text preserves the
host agent's existing configured prompt; the adapter returns that existing worker
without rebuilding it. `all` preserves its already enforced ceiling. The current
planner instance/configuration remains in legacy mode; the fallback remains available
where hosts currently use it. No worker base or function prompt is added by the library.

New state uses optional additive role fields; plan `version: 1` stays unchanged.
On loading state without them, normalize `worker: 'checker'` to verdict and other
workers to report, preserving names, task IDs and source bindings. Thus a legacy
checker maps to the default verdict profile without rewriting identities or running
an offline migration. Explicit-source hosts restoring such plans must expose an
enabled verdict profile named `checker` (an alias record is sufficient), or reopen
and reassign the step explicitly; do not choose an arbitrary verdict profile.

Persisted verdicts without exact source bindings must still be rerun. Keep existing
`restoreLegacyStep` handling of old `check` metadata and `checking` states. Missing
profiles leave retained step/task roles and delivery restrictions intact. Persist
no prompt bodies or tool authorization in dialogue state; source data is reloaded
for future tasks and completed work remains auditable through recorded identities.

## Tool security

Profiles are editable configuration data, never authority to grant tools. The library
passes `tools` unchanged to `profileRunner.createWorker`; it does not interpret tool
names or decide whether a tool is read-only. The host computes effective permissions
as the intersection of its code-owned ceiling and the requested policy. `all` means
all tools within that ceiling; deny wins over allow; omitted allow leaves the ceiling
unchanged before deny. The host defines exact tool identities and read-only classes;
unknown or unsupported policies fail closed. Verdict runners enforce a read-only
ceiling regardless of a profile's requested tools.

The host must filter offered definitions and enforce calls at execution, including
MCP, external/client tools, nested delegation and resumed calls. An allowed tool
cannot obtain broader privileges indirectly. Source failures and disabled records
never select a more privileged agent. The library cannot sandbox an arbitrary host
`ISubAgent`; this enforcement is an explicit host integration obligation, not a
security property supplied by prompt wording.

## Tests

- Public contract/type fixtures for Result errors, all policy shapes, optional legacy
  fields and unchanged workers-map construction; root exports resolve.
- Discovery in prepared/conversation modes and corrective calls; exact named lookup,
  disabled/missing/invalid profiles, mismatched returned names and delegate-time edits.
- Source deadlines, cancellation, thrown errors, no stale fallback, empty versus absent
  planner text; no execution after runner failure. Queue an edit and verify start-time
  text/policy refresh; running tasks keep their snapshot. No mutable cross-task leaks.
- Host base/profile/static guidance order; no duplicate request-time guidance; goals,
  time lines and semantic skills stay in request content. Planner overrides refresh on
  the next call; static prefix remains equal for unchanged profile/base.
- Two report and two verdict profiles with arbitrary names: role mismatch rejection,
  independent source checks, dependency forwarding, batch/count parsing, stale events,
  role/name changes, budgets and delivery gates. Rename checker in existing fixtures
  to prove no operational name coupling remains outside compatibility normalization.
- Legacy workers maps, text/unstructured tasks and persisted checker plans restore;
  additive snapshots round-trip; removed profiles cannot bypass verification. Preserve
  current source binding, old check/checking, request ownership and delivery tests.
- Host hook conformance: all cannot exceed ceiling, deny wins, verdict read-only ceiling,
  disabled tool calls fail even if invoked directly, and external/nested paths obey it.
- Manual integration: add a host RAG profile without code changes, select it by its
  description, edit prompt/tools, run the next task and observe the new instructions
  and narrowed tools. Disable it and observe a named error with no worker run.

## Rollout

Implementation warrants minor changesets for `@mcp-abap-adt/llm-agent` (additive public
contracts) and `@mcp-abap-adt/llm-agent-libs` (resolution, assembly and generalized
verification), preserving legacy defaults. Export the contracts, document source and
runner obligations and update the focused dialogue/context tests; run package tests,
repository lint checks and build. Hosts then supply their RAG-backed source, enforcing
runner and prompt seeds. No new library environment variable or backend is required.

This change delivers the design document only; implementation and changeset files
are subsequent work.
