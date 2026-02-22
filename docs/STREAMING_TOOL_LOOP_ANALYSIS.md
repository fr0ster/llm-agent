# Streaming and Iterative Tool Loop: Analysis

## Where the decision is made

Streaming is a pipeline decision, not an architecture decision. The pipeline defines:
- **Whether to use streaming** - some scenarios (batch, internal calls) do not need streaming at all
- **Which streaming type to use** - text chunks, typed events, or a combination
- **What to stream** - only final text, or also tool-call events and subprompt-level responses

SSE is already in the stack through MCP transport. The OpenAI-compatible protocol defines the format: send a chunk when it is ready, close the connection when everything is done. The pipeline only decides what and when to push into that stream.

---

## Core problem

In an iterative tool loop, the agent does not know in advance which iteration will be the last. Each LLM response may contain `tool_call` (loop continues) or final text (loop ends). The question is: what should be streamed, and when?

```text
Iteration 1: LLM → tool_call("search", {...})
Iteration 2: LLM → tool_call("read_file", {...})
Iteration 3: LLM → "Here is the result: ..."   ← only here is there text to stream?
```

**Important:** parallel tool-call execution does not solve this. The tool loop is sequential - each next LLM call depends on the previous result. You can parallelize multiple `tool_call`s within a single LLM response, but not the iterations themselves.

## Why this is not an architectural conflict

The protocol already solves this. OpenAI-compatible streaming is simple: emit a chunk as soon as it is ready, close the connection when complete. SSE is already in the stack, and MCP uses it as one transport option (alongside stdio and HTTP). No separate transport layer is needed.

The agent simply streams whatever is ready at each moment:

```text
→ chunk: "Noted: tables now use UUID instead of int id."      (fact processed)
→ chunk: [tool_call event: calling search(...)]               (action started)
→ chunk: [tool_result event: search result]
→ chunk: "Here is the users table schema: ..."                (final response)
→ [connection closed]
```

## Partial solution via subprompt decomposition

Subprompt decomposition provides concrete gains in perceived latency. If a message contains multiple subprompts, the agent streams each subprompt result immediately after it completes, without waiting for the rest:

```text
Input: "By the way, tables now use UUID instead of int id.
        Show me the users table schema."

Subprompt 1 (fact):   "By the way, tables now use UUID instead of int id"
Subprompt 2 (action): "Show me the users table schema"

→ Stream immediately: "Noted: tables now use UUID instead of int id."
  (in parallel, start the action tool loop)
→ Stream later: schema result
→ [connection closed]
```

The user sees partial responses as processing progresses, without waiting for the full request to finish. This is a direct benefit of subprompt taxonomy, not a separate optimization.

## What to stream during tool calls

During a tool call, the agent may have no text to stream, but it can emit typed events:

| Moment | What to stream |
|--------|------------|
| Subprompt processed | Text response for that subprompt |
| Tool call chosen by LLM | Event with tool name and arguments |
| Tool result received | Event with result (or concise text) |
| Final LLM response | Text delta chunks |
| Everything completed | Close connection |

## References

- [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling) - streaming with tool calls via `stream: true`, delta chunks with `tool_calls`
- [Anthropic Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming) - `content_block_start` / `content_block_delta` / `message_stop` for tool use
- [OpenAI Assistants Function Calling](https://platform.openai.com/docs/assistants/tools/function-calling) - event-based approach: `tool_calls.created`, `tool_calls.delta`
- [AG-UI Protocol](https://docs.ag-ui.com/) - open standard for agentic streaming between backend and UI
- [Microsoft Semantic Kernel - Agent Streaming](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-streaming) - `IAsyncEnumerable` with `FunctionCallContent` and `FunctionResultContent` types in the stream
