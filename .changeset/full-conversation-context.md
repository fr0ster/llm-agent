---
"@mcp-abap-adt/llm-agent": major
"@mcp-abap-adt/llm-agent-libs": major
"@mcp-abap-adt/llm-agent-server-libs": major
---

Remove implicit conversation and message truncation throughout adaptive and dialogue coordination. Workers receive every supplied history message and complete selected results; adaptive planning retains full message content and metadata and previous-run output. Dialogue storage and restoration retain all conversation messages, request text, request records and transcripts, including closed requests. Planner projection preserves complete replies and internal events instead of replacing or dropping older entries.

Breaking API change in llm-agent-libs: remove the public HISTORY_MESSAGE_LIMIT, RESULT_CHAR_LIMIT, DIALOGUE_HISTORY_LIMIT and TASK_OUTPUT_CHAR_LIMIT exports. Remove imports of these constants; no replacement limit is necessary. Task output and tool-loop rounds are unlimited by default; explicit taskOutputChars and keepLastRounds settings still apply. Explicit history selection modes, historyRecencyWindow, opt-in tool-result limits and token/usage accounting are preserved. Automatic conversation-history summarization is removed. SummarizeHandler, the summarize stage, summarizeHistory, withHistorySummarization, withSessionTokenBudget, historySummaryPrompt, historyAutoSummarizeLimit, sessionTokenBudget and YAML prompts.historySummary remain accepted as deprecated no-ops; they make no helper LLM call, change no history and create no history RAG store. Opt-in semantic turn indexing remains supported separately. Auxiliary HistoryMemory retention is unlimited by default; explicit maxSize settings, including historyRecencyWindow-based builder sizing, remain supported. Report and verdict summaries, task notices, dispatch/replanning results and prerequisite-step inputs retain their complete content. Remove the implicit 120000-character aggregate delegation-context gate, so large legacy results and check evidence reach downstream workers intact.

Server controller board rendering, reviewer digests and finalizer result rendering no longer truncate or omit content to satisfy character budgets. Existing budget arguments, policy fields and helper names remain accepted for source compatibility but no longer constrain rendered content. This is a breaking behavioral change for consumers relying on bounded board, digest or finalizer text.

Breaking controller persistence change: durable controller storage is now scoped to the validated caller identity (userId and sessionId). Bundles written by earlier versions under the bare sessionId do not record an owner, so they cannot be safely migrated by sessionId alone. These legacy records remain untouched in storage and are not exposed or resumed after upgrade. Clients must restart controller runs suspended before the upgrade as new runs (without the old runId, or with newRun: true). Transcript/context-strategy migration still applies to bundles already in caller-scoped storage.

Detection of legacy truncation markers remains for persisted transcripts written by older versions, so memory retrieval can still compensate for historically missing content. New default conversation paths do not generate those markers. Retrieval snippet budgets and diagnostic previews are separate from retained conversation history.

Context assembly is unchanged regarding client system messages: client-supplied system messages remain excluded from assembled model input as on origin/main. The action text is added as a user message only when there are no windowed messages. Direct, pipeline and server controller tool loops retain validation exchanges and retry corrections after subsequent tool rounds. An explicit taskOutputChars limit also applies to report summaries, including fallback summaries exposed in planner notices; the result store still receives the full output. Restoring large request histories computes the highest request ID iteratively without passing the entire history as function arguments.

Breaking API change in llm-agent: remove TOOL_TRACE_MAX_ENTRIES, TOOL_TRACE_ARGUMENT_CHARS, TOOL_TRACE_RESULT_CHARS, TOOL_TRACE_ERROR_CHARS and TOOL_TRACE_RENDER_CHARS. Tool evidence now retains every call and complete sanitized fields, and model-visible rendering preserves all entries without character caps. Secret redaction and legacy omittedCount metadata remain supported; sanitizeTraceValue still honors its explicit caller-supplied limit.

Breaking default strategy change: every built-in pipeline (including controller
and controller-weak), bare builder, SmartServer and YAML configuration now uses
LegacyAccumulateContextStrategy and sends the full tool-loop history to the
model, including every assistant message, tool-call argument and tool result.
The controller no longer implicitly selects RagRecall, and the server no longer
selects Window. Consumers must explicitly inject toolLoopContextStrategyFactory
to use a lossy strategy. The former controller RAG implementation remains
available through createControllerRagRecallContextStrategyFactory(budgets) from
@mcp-abap-adt/llm-agent-server-libs/controller. Explicit keepLastRounds windows
and custom factories remain supported. Validation replies and corrections keep
their original positions between tool rounds rather than moving after newer
results; both direct and pipeline loops preserve chronological order.
