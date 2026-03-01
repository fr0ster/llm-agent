# Development Roadmap

Planned features and open research questions for future iterations.
Current stable baseline: SmartAgent + SmartServer + pipeline configuration (see `ARCHITECTURE.md`).

---

## Next Iteration — Real Incremental Streaming

### What we want

Replace the current "batch-then-emit" SSE with true incremental streaming: LLM tokens arrive at
the client as they are generated, tool-call events are emitted between loop iterations, and the
connection stays open until the pipeline finishes.

### What needs to change (preliminary)

| Layer | Current state | Target |
|---|---|---|
| `ILlm` | `chat() → Result<LlmResponse>` (full response) | add `streamChat() → AsyncGenerator<LlmChunk>` |
| `SmartAgent` | returns after full pipeline | yields chunks from LLM + tool-call events |
| `SmartServer` | sends all SSE chunks at once after `process()` | pipes generator into SSE connection |

### Open questions — must answer before design

#### Q1. What does the OpenAI-compatible streaming protocol actually require?

- What is the exact SSE chunk schema for a streaming `chat/completions` response?
- When does the `finish_reason` field appear, and in which chunk?
- How are `tool_calls` represented in streaming chunks — are they sent as deltas across multiple
  chunks or as a single chunk?
- What does `stream_options: { include_usage: true }` add, and when is the usage chunk emitted?
- Is there a difference between streaming with and without tools in the response schema?
- Reference: OpenAI streaming docs + actual wire captures

#### Q2. How does Cline process streaming responses on the client side?

- Does Cline buffer chunks until `finish_reason` or process them incrementally?
- How does Cline handle a `tool_calls` delta that arrives across multiple chunks?
- Does Cline display partial text to the user while the stream is in progress?
- Does Cline break if `tool_calls` chunks arrive mid-stream from a SmartAgent response?
- What happens in Cline's `passthrough` path today vs. what SmartAgent would emit?
- Source: Cline source code / observed behaviour

#### Q3. What do reference implementations emit?

- What exact SSE stream does **ChatGPT** (or the official OpenAI API) produce for a tool-using
  request? Capture a real wire trace.
- What do other OpenAI-compatible servers emit (LM Studio, Ollama, LiteLLM, vLLM)?
- Is there a de-facto standard for streaming tool-call events that differs from the official spec?
- Who is currently the most reliable reference for OpenAI streaming compatibility?

#### Q4. What should SmartAgent stream during the tool loop?

- Option A: stream only the final LLM text response; tool iterations are silent.
- Option B: emit typed tool-call events between iterations so the client can show progress.
- Option C: stream text tokens from each LLM iteration, including intermediate reasoning.
- Which option is compatible with Cline and similar clients without breaking their parsers?
- Reference: archived `STREAMING_TOOL_LOOP_ANALYSIS.md` contains preliminary analysis.

#### Q5. What changes are needed in `ILlm` and adapters?

- Can `streamChat()` be added to `ILlm` as optional without breaking existing implementations?
- How do `LlmAdapter` (wraps `BaseAgent`) and `TokenCountingLlm` (decorator) need to change?
- Do provider agents (`DeepSeekAgent`, `OpenAIAgent`, `AnthropicAgent`) already support streaming
  at the HTTP level, or do they need new provider calls?

---

## Other Planned Items

### `helperLlm` — preprocessing LLM (implemented)

The `helperLlm?: ILlm` field in `SmartAgentDeps` is fully implemented. It serves as a
dedicated lightweight LLM for two preprocessing tasks, keeping the main LLM free for
the primary chat loop:

- **RAG query translation** (`_toEnglishForRag`): translates non-ASCII user text to English
  before querying RAG stores. Falls back to `mainLlm` when `helperLlm` is not provided.
- **History summarization** (`_summarizeHistory`): condenses long conversation history when
  `Message[]` length exceeds `historyAutoSummarizeLimit`. Only runs when `helperLlm` is set.

### Streaming tool-call events to the client

Covered under Q4 above. Depends on resolving the OpenAI-compatibility questions first.

### OllamaRag — production hardening

- Connection retry and timeout on embed API calls
- Configurable request timeout (`ollamaTimeoutMs`)
- Health-check on startup (warn if Ollama is unreachable rather than silently failing at first query)
