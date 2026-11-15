---
"@mcp-abap-adt/llm-agent": major
"@mcp-abap-adt/llm-agent-libs": major
"@mcp-abap-adt/llm-agent-server-libs": major
"@mcp-abap-adt/llm-agent-server": major
---

Disable default tool-loop iteration and tool-call limits. Unset `maxIterations`
and `maxToolCalls` mean unlimited and are represented by `undefined`, omitted in
config JSON. Typed programmatic APIs (`SmartAgentConfig`, builder config,
`withMaxIterations`/`withMaxToolCalls`, and runtime config patches) accept
`number | null | undefined`: absent values, `null`, and numeric `Infinity` mean
unlimited. Integer strings are accepted only at text boundaries: YAML startup
and reload, HTTP `PUT /v1/config` bodies, and environment substitutions.
All entry points use the shared normalizer for runtime validation:
`maxIterations` requires positive integers, and `maxToolCalls` requires
non-negative integers. Invalid values fail with an error naming the field.
Explicit limits keep their previous
termination behavior and budget-exhaustion reporting, including `maxToolCalls: 0`
forbidding tool calls and exhausting the budget immediately, even when
SelfDispatch has no tools or executor.

Numeric `Infinity` remains supported as unlimited for both limits and is omitted from config JSON; the string `'Infinity'`, `-Infinity`, and `NaN` are rejected.

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
