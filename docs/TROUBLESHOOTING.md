# Troubleshooting

Recurring issues, root causes, and fixes for the smart-agent stack.

---

## Cline: "Invalid API Response" after correct answer

**Symptom:**
Cline displays the correct result (e.g. SAP table structure) but then shows
"Invalid API Response: tool calls that Cline cannot process" and retries.

**Root cause:**
Cline **always** uses `stream: true`. The `<attempt_completion>` XML wrapper was only
applied in the non-streaming code path — dead code for Cline.

Without `<attempt_completion>`, Cline does not recognise the response as a completed
tool use and retries with `[ERROR] You did not use a tool...`.

**Fix (2026-02-25):**
`_handleSmartStream(wrapForCline?)` — when `true`:
- Emits `<attempt_completion>\n<result>\n` as the first SSE chunk before pipeline starts.
- Emits `\n</result>\n</attempt_completion>` inside the `done` chunk handler, before
  `finish_reason`.

Hard-mode streaming call passes `isCline` as `wrapForCline`.

**Note:** `stream` is not logged in `client_request` events, so session logs may
show `stream: null` even for streaming requests. Always assume Cline streams.

---

## Cline: wrong tool selected (GetTableContents instead of GetTable)

**Symptom:**
"Read structure of table T000" → agent calls `GetTableContents` (rows) not `GetTable`
(definition).

**Root cause:**
1. `ragMinScore: 0.55` — `GetTable` cosine score was below threshold, so it was
   never included in the LLM context.
2. No disambiguation rules in the system prompt — LLM defaulted to the more
   commonly used data-reading tool.

**Fix (2026-02-25):**
- Lower `ragMinScore: 0.55 → 0.45` in `smart-server.yaml`.
- Add rules to `prompts.system`:
  ```
  - To read STRUCTURE / DEFINITION / FIELDS of an ABAP table → use GetTable.
  - To read DATA / ROWS / CONTENTS of an ABAP table → use GetTableContents.
  - Never call GetTableContents when the user asks for structure, fields, or metadata.
  ```

---

## Classifier selects file tools instead of SAP tools (Cline environment_details bias)

**Symptom:**
Classify returns action like "Read structure of table T000 **from file
gen/t000_table_structure.md**". File-system tools are selected instead of SAP tools.

**Root cause:**
Cline embeds a large `<environment_details>` block (file tree, open editors) in every
user message. The classifier reads all of it and anchors the action to local files it
sees listed.

**Fix (2026-02-25):**
Extract only the `<task>` content before classification:
```typescript
const taskMatch = rawText.match(/<task>([\s\S]*?)<\/task>/);
const text = taskMatch ? taskMatch[1].trim() : rawText;
```

---

## All 134 MCP tools sent to LLM for unrelated requests

**Symptom:**
Simple or non-SAP requests (e.g. "install ripgrep", math questions) cause the agent
to include all 134 SAP tools in the LLM context, inflating token usage and confusing
the model.

**Root cause:**
When RAG returned 0 results for a non-SAP action, the pipeline fell back to
`selectedTools = mcpTools` (all tools).

**Fix (2026-02-25):**
Remove the fallback entirely:
```typescript
const selectedTools = mcpTools.filter(t => ragToolNames.has(t.name));
```
If RAG finds nothing relevant, LLM receives 0 tools and answers freely.

---

## Goose: 2.5-minute response time for meta-requests

**Symptom:**
Goose meta-requests (session naming, summarisation) with `stream: false` take ~2.5 min.

**Root cause:**
Non-streaming smart path called `smartAgent.process(text)` which is the **hard**
pipeline — it ignored `clientMessages` and tried to find SAP actions in the meta-text.

**Fix (2026-02-25):**
Collect chunks from `processStream(text, { clientMessages })` instead of `process()`.
Smart mode now preserves full client conversation history for both streaming and
non-streaming requests.

---

## Cline: 93-second response, 10 iterations, XML/JSON tool conflict

**Symptom:**
In `smart` mode, Cline requests take 93 seconds with 10 LLM iterations.
Error: "Invalid API Response: tool calls that Cline cannot process".

**Root cause:**
Smart mode forwarded `clientTools` in JSON function-calling format to the LLM.
Cline's own system prompt instructs the LLM to use XML tool syntax
(`<tool_name>…</tool_name>`). The model alternated between both formats without
completing the task.

**Fix (2026-02-25):**
In `smart` mode, auto-detect Cline and route to **hard** pipeline:
```typescript
const isCline = systemText.trimStart().startsWith('You are Cline');
const useHard = serverMode === 'hard' || (serverMode === 'smart' && isCline);
```
Agent executes MCP tools itself and returns plain text. Cline never sees JSON
`tool_calls`. Works even when Cline has no SAP MCP configured.
