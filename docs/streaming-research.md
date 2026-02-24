# Streaming Research

---

## 1. OpenAI SSE Wire Format

### Transport

Every streamed response from `POST /v1/chat/completions` (with `"stream": true`) is
`text/event-stream`. Each line on the wire:

```
data: <JSON>\n\n
```

Stream ends with:

```
data: [DONE]\n\n
```

No `event:` or `id:` SSE fields — only `data:` lines.

---

### ChatCompletionChunk schema

```typescript
{
  id: string;                          // same on every chunk in the stream
  object: 'chat.completion.chunk';
  created: number;                     // unix timestamp, same on every chunk
  model: string;
  system_fingerprint?: string | null;
  service_tier?: string | null;
  usage: CompletionUsage | null;       // null on all chunks except the usage chunk
  choices: Choice[];                   // always length 1; empty [] on usage-only chunk
}

// Choice
{
  index: number;
  delta: ChoiceDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  logprobs?: ChoiceLogprobs | null;
}

// Delta — only non-null fields are sent
{
  role?: 'assistant';                  // only in the very first chunk
  content?: string | null;            // token fragment, or null when tool_calls are emitted
  refusal?: string | null;
  tool_calls?: ChoiceDeltaToolCall[] | null;
}

// Tool call delta
{
  index: number;      // ALWAYS present — merge key
  id?: string | null; // only in the FIRST chunk for this tool call
  type?: 'function';  // only in the FIRST chunk for this tool call
  function?: {
    name?: string | null;      // only in the FIRST chunk for this tool call
    arguments?: string | null; // partial JSON string — accumulate across chunks
  };
}
```

---

### Chunk sequence: simple text response

```
// Chunk 1: role announcement, empty content
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1721075653,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}

// Chunks 2..N-1: token fragments
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1721075653,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Two"},"finish_reason":null}],"usage":null}
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1721075653,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":" plus two is four."},"finish_reason":null}],"usage":null}

// Final chunk: empty delta, finish_reason set
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1721075653,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}

data: [DONE]
```

---

### Chunk sequence: single tool call

```
// Chunk 1: role, content is null (not "")
data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","created":1744190622,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":null},"finish_reason":null}],"usage":null}

// Chunk 2: FIRST tool chunk — id + type + name + empty arguments
data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","created":1744190622,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}],"usage":null}

// Chunks 3..N-1: argument fragments only (no id, no name)
data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","created":1744190622,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"location\":"}}]},"finish_reason":null}],"usage":null}
data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","created":1744190622,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \"Boston\"}"}}]},"finish_reason":null}],"usage":null}

// Final chunk: empty delta, finish_reason "tool_calls"
data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","created":1744190622,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":null}

data: [DONE]
```

---

### Chunk sequence: multiple tool calls in one turn

Tool calls stream sequentially by `index` — all of call 0 before call 1.

```
// Chunk 1: role
data: {...,"choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}],...}

// First chunk for tool call 0
data: {...,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"tool_a","arguments":""}}]},"finish_reason":null}],...}

// Argument fragments for tool call 0
data: {...,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"x\": 1}"}}]},"finish_reason":null}],...}

// First chunk for tool call 1 (new index!)
data: {...,"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"tool_b","arguments":""}}]},"finish_reason":null}],...}

// Argument fragments for tool call 1
data: {...,"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"y\": 2}"}}]},"finish_reason":null}],...}

// Final chunk
data: {...,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],...}

data: [DONE]
```

---

### finish_reason values

| Scenario | Value |
|---|---|
| Normal text completion | `"stop"` |
| Hit max_tokens | `"length"` |
| Model called tool(s) | `"tool_calls"` |
| Content filtered | `"content_filter"` |

`finish_reason` always appears in its own dedicated chunk where `delta` is `{}`.
It is `null` on every preceding chunk.

> **Caveat:** when `tool_choice: "required"` is set, some model versions return `"stop"` instead
> of `"tool_calls"`. Robust parsers check the accumulated delta for tool_calls content and do not
> rely solely on `finish_reason`.

---

### stream_options: { include_usage: true }

Adds one extra chunk between the `finish_reason` chunk and `[DONE]`.
Detection: `choices.length === 0`.

```
// finish_reason chunk
data: {...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}

// usage chunk — choices is EMPTY ARRAY
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1721075653,"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":18,"completion_tokens":2,"total_tokens":20}}

data: [DONE]
```

Order: `content chunks → finish_reason chunk → [usage chunk] → [DONE]`

---

### [DONE] sentinel

```
data: [DONE]
```

Not valid JSON. Do not `JSON.parse`. Always the last line of the stream.

---

### Tool call accumulation algorithm

```typescript
const toolCallsMap = new Map<number, {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}>();

for await (const chunk of stream) {
  if (chunk.choices.length === 0) {
    // usage chunk
    handleUsage(chunk.usage);
    continue;
  }

  const delta = chunk.choices[0].delta;

  if (delta.content != null) {
    textBuffer += delta.content;
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (!toolCallsMap.has(tc.index)) {
        // first chunk for this tool call
        toolCallsMap.set(tc.index, {
          id: tc.id!,
          type: 'function',
          function: { name: tc.function!.name!, arguments: '' },
        });
      } else {
        // subsequent chunks — accumulate arguments only
        toolCallsMap.get(tc.index)!.function.arguments += tc.function?.arguments ?? '';
      }
    }
  }

  if (chunk.choices[0].finish_reason === 'tool_calls') {
    const toolCalls = [...toolCallsMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);
    handleToolCalls(toolCalls);
  }
}
```

---

### Text vs tool-call chunk differences

| Field | Text response | Tool call response |
|---|---|---|
| Chunk 1 `delta.content` | `""` | `null` |
| Chunks 2..N `delta.content` | token text | `null` |
| First tool chunk `id` | — | present |
| First tool chunk `function.name` | — | present |
| First tool chunk `function.arguments` | — | `""` |
| Subsequent tool chunks `id` | — | absent |
| Final `finish_reason` | `"stop"` | `"tool_calls"` |

---

## 2. Cline Streaming Behavior

### Incremental vs buffered

Cline processes chunks **incrementally** — it does not buffer until `finish_reason`.
Each SSE chunk is handled in a `for await (const chunk of stream)` loop in `/src/core/task/index.ts`.
Text tokens appear in the UI as they arrive via `this.say("text", content, ..., partial=true)`.

`finish_reason` is never explicitly checked — the OpenAI SDK async iterator ends naturally
when the stream closes (server sends `[DONE]`). A server that sends `finish_reason` but keeps
the stream open causes Cline to hang.

---

### Tool call delta accumulation

Cline uses a dedicated `ToolCallProcessor` class (`/src/core/api/transform/tool-call-processor.ts`)
that accumulates deltas across chunks:

```typescript
export class ToolCallProcessor {
  *processToolCallDeltas(toolCallDeltas) {
    for (const toolCallDelta of toolCallDeltas) {
      if (toolCallDelta.id) this.lastToolCall.id = toolCallDelta.id
      if (toolCallDelta.function?.name) this.lastToolCall.name = toolCallDelta.function.name
      if (this.lastToolCall.id && this.lastToolCall.name && toolCallDelta.function?.arguments) {
        yield { type: 'tool_calls', tool_call: { ... } }
      }
    }
  }
}
```

Arguments are parsed incrementally with `@streamparser/json`.
Tool **execution** happens only after the stream ends: finalized tool use blocks are collected
via `toolUseHandler.getAllFinalizedToolUses()` after the loop, then executed.

---

### Native tool calls vs XML mode

Cline has two modes for tool calling:

**XML mode (default for custom OpenAI-compatible endpoints):**
- No `tools` array is sent to the API
- Server must return tool calls as XML in `delta.content` (e.g. `<read_file>...</read_file>`)
- `parseAssistantMessageV2()` re-parses the accumulated text on every chunk looking for XML tags
- Text emitted in `delta.content` that doesn't match XML tags is shown as plain text

**Native tool calls mode (`nativeToolCallEnabled: true`):**
- Cline sends a `tools` array and expects `delta.tool_calls` in chunks
- Text emitted in `delta.content` is shown as plain text and NOT executed as a tool
- Must be explicitly enabled in global state — not automatic for custom endpoints

**Implication for SmartAgent:** if SmartAgent emits tool-call events as plain text in
`delta.content`, Cline will display them as text (not execute them) when in native mode.
In XML mode, the server must produce Cline-compatible XML.

---

### SSE parser

Cline uses the **official `openai` npm SDK** — no custom SSE parser:

```typescript
import OpenAI from 'openai'
const stream = await client.chat.completions.create({
  model, messages, stream: true,
  stream_options: { include_usage: true },
  ...getOpenAIToolParams(tools),
})
for await (const chunk of stream) { /* process */ }
```

---

### Known compatibility issues with custom OpenAI-compatible servers

| Issue | Detail |
|---|---|
| `usage: null` breaks context bar | Cline reads `chunk.usage.prompt_tokens` unconditionally — returns 0 if null |
| Tool ID length limit | Max 40 chars (`MAX_TOOL_CALL_ID_LENGTH`). Longer IDs are silently truncated |
| `stream_options` rejection | Cline always sends `stream_options: { include_usage: true }` — servers that reject it return 400 |
| Native tool calls not auto-enabled | Must explicitly set `nativeToolCallEnabled: true` for custom endpoints |
| `finish_reason` not checked | Cline relies on stream close, not `finish_reason`. Wrong `finish_reason` value has no effect |

---

### Key source files

| File | Role |
|---|---|
| `/src/core/api/providers/openai.ts` | OpenAI-compatible provider; iterates chunks |
| `/src/core/api/transform/tool-call-processor.ts` | Accumulates tool call deltas |
| `/src/core/task/StreamResponseHandler.ts` | `ToolUseHandler` (JSON streaming parser) |
| `/src/core/task/index.ts` | Main `for await` loop (~line 2649) |
| `/src/core/assistant-message/parse-assistant-message.ts` | XML-based tool call parser |
| `/src/shared/net.ts` | `createOpenAIClient` factory |

---

## 3. Reference Implementations: LiteLLM, Ollama, vLLM

### Cross-server comparison

| Behavior | OpenAI spec | LiteLLM | Ollama | vLLM |
|---|---|---|---|---|
| `data: [DONE]\n\n` at end | yes | pass-through | yes | yes |
| `usage` on intermediate chunks | omitted | omitted (deleted) | omitted (`omitempty`) | omitted |
| Final usage chunk `choices` | `[]` | `[StreamingChoices(...)]` ← **deviation** | `[]` (explicit) | `[]` (explicit) |
| `finish_reason: null` on intermediate | explicit null | depends on upstream | explicit null (`*string`, no omitempty) | pre-v0.9.0 yes; v0.9.0+ **omitted** (bug) |
| `finish_reason` placement | separate empty-delta chunk | separate chunk | **combined** with final content ← deviation | **combined** with final content ← deviation |
| Tool call first chunk | `id`+`type`+`index`+`name`+`arguments:""` | pass-through | full tool call in one chunk ← deviation | incremental (bugs with specific `tool_choice`) |
| Tool call argument streaming | incremental per-token | pass-through | **all at once** ← deviation | incremental per-token |
| `role` in delta | first chunk only | pass-through | **every chunk** ← deviation | first chunk only |
| `stream_options.include_usage` | yes | yes | yes (Feb 2026) | yes |

---

### LiteLLM

Key files: `litellm/litellm_core_utils/streaming_handler.py`, `litellm/types/utils.py`

- Primarily a pass-through proxy — normalizes upstream chunks and re-serializes to SSE
- Uses `exclude_unset=True` on `model_dump()` — unset fields are omitted (not sent as null)
- `usage` is explicitly deleted from intermediate chunks before serialization
- Final usage chunk: `choices: [StreamingChoices(finish_reason=None)]` — single choice with empty delta, **not** `choices: []` as OpenAI spec requires
- `finish_reason` in a separate empty-delta chunk (matching OpenAI)
- Normalizes missing `type: "function"` in tool call deltas from upstream
- `[DONE]` comes from upstream — LiteLLM does not generate its own

---

### Ollama

Key files: `middleware/openai.go` (`ChatWriter`), `openai/openai.go` (`ToChunk`, `ToToolCalls`)

```go
// ChatWriter.writeResponse() — SSE serialization
w.ResponseWriter.Write([]byte(fmt.Sprintf("data: %s\n\n", d)))
if chatResponse.Done {
    if w.streamOptions != nil && w.streamOptions.IncludeUsage {
        c.Usage = &u
        c.Choices = []openai.ChunkChoice{}   // correct: empty array on usage chunk
        w.ResponseWriter.Write([]byte(fmt.Sprintf("data: %s\n\n", d)))
    }
    w.ResponseWriter.Write([]byte("data: [DONE]\n\n"))
}
```

Deviations:
- `role: "assistant"` on **every** chunk, not just the first
- Tool calls sent **all at once in a single chunk** (not incrementally)
- `finish_reason` combined with final content in the same chunk (not separate)
- `SystemFingerprint` hardcoded as `"fp_ollama"`
- No `completion_tokens_details` in usage

---

### vLLM

Key file: `vllm/entrypoints/openai/chat_completion/serving.py`

```python
data = chunk.model_dump_json(exclude_none=True)   # v0.9.0+
yield f"data: {data}\n\n"
yield "data: [DONE]\n\n"
```

Deviations:
- v0.9.0+: `finish_reason: null` **omitted** from intermediate chunks (should be explicit null per spec) — regression from `exclude_none=True`
- `finish_reason` combined with final content (not separate empty-delta chunk)
- Known bugs: `type: "function"` and `id` missing from first tool chunk when `tool_choice` is a specific function
- Known bug: `function.name` repeated in every argument delta chunk (clients accumulate concatenated names)
- Final usage chunk correctly uses `choices: []`
- Extension: `continuous_usage_stats` — usage in every chunk (non-standard)

---

### Conclusions for SmartAgent implementation

1. **`finish_reason` in a separate empty-delta chunk** — follow OpenAI spec and LiteLLM; Ollama/vLLM deviate here but Cline doesn't check `finish_reason` anyway (relies on stream close)
2. **Usage chunk `choices: []`** — use empty array, not `[StreamingChoices(...)]`; Ollama and vLLM do it correctly
3. **Intermediate chunks: omit `usage`** entirely (or send `null`) — all implementations agree
4. **Tool call streaming: incremental** — follow OpenAI/vLLM pattern; Ollama's all-at-once is a known limitation
5. **`role` only on first chunk** — Ollama sends it on every chunk but spec says first only; Cline handles both

---

## Sources

- [OpenAI API Reference — Chat Completions Streaming](https://platform.openai.com/docs/api-reference/chat-streaming)
- [OpenAI — Streaming API Responses guide](https://platform.openai.com/docs/guides/streaming-responses)
- [OpenAI Cookbook — How to stream completions](https://github.com/openai/openai-cookbook/blob/main/examples/How_to_stream_completions.ipynb)
- [OpenAI Python SDK — ChatCompletionChunk type](https://github.com/openai/openai-python/blob/main/src/openai/types/chat/chat_completion_chunk.py)
- [Usage stats for streaming — OpenAI Community](https://community.openai.com/t/usage-stats-now-available-when-using-streaming-with-the-chat-completions-api-or-completions-api/738156)
- [Streaming chunk format with multiple tool calls — OpenAI Community](https://community.openai.com/t/streaming-chunk-format-with-multiple-choices-or-tool-calls/1351422)
- [LiteLLM streaming_handler.py](https://github.com/BerriAI/litellm/blob/main/litellm/litellm_core_utils/streaming_handler.py)
- [LiteLLM types/utils.py](https://github.com/BerriAI/litellm/blob/main/litellm/types/utils.py)
- [Ollama middleware/openai.go](https://github.com/ollama/ollama/blob/main/middleware/openai.go)
- [Ollama openai/openai.go](https://github.com/ollama/ollama/blob/main/openai/openai.go)
- [vLLM chat_completion/serving.py](https://github.com/vllm-project/vllm/blob/main/vllm/entrypoints/openai/chat_completion/serving.py)
- [vLLM issue #19650 — finish_reason:null regression](https://github.com/vllm-project/vllm/issues/19650)
- [vLLM issue #14951 — function.name repeated in every delta](https://github.com/vllm-project/vllm/issues/14951)
