---
"@mcp-abap-adt/llm-agent": major
"@mcp-abap-adt/llm-agent-libs": major
"@mcp-abap-adt/llm-agent-server-libs": major
"@mcp-abap-adt/llm-agent-server": major
---

Disable default tool-loop iteration and tool-call limits. Unset `maxIterations`
and `maxToolCalls` mean unlimited and are represented by `undefined`, omitted in
config JSON. PUT, runtime config patches, and YAML normalize `null` iteration
limits to unset and reject non-positive or non-integer iteration limits.
Explicit positive limits keep their previous termination behavior and
budget-exhaustion reporting.

SelfDispatch no longer has an implicit six-round limit; the builder passes its
explicit agent iteration limit to the default coordinator fallback.

Migration: set `agent.maxIterations: 10` and `agent.maxToolCalls: 30` (or use
`withMaxIterations(10).withMaxToolCalls(30)`) to retain the previous builder and
server defaults. For standalone `DefaultPipeline`, set
`agentConfig.maxIterations: 10`. Set controller `budgets.maxToolCalls: 10` to keep
its previous per-worker limit. Cyclic/recursive Stepper executors no longer have
an implicit 10-iteration cap; direct `CyclicReActExecutor` consumers can still
pass an explicit `maxIterations`. The explicit `simple` executor profile retains
its single-pass behavior.

Derived controller recall bounds use stored artifact counts when tool-call limits
are unset, keeping queries finite without imposing an execution limit. Pipeline
repeat-stage `stage.maxIterations` is also optional and unlimited when omitted;
set it to `10` to retain the previous default. Controller `maxSteps`/`maxRetries`
are unchanged.
