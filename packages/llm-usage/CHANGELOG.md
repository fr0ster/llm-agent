# @mcp-abap-adt/llm-usage

## 1.3.0

### Minor Changes

- 94e1af6: SAP AI Core streaming: recover the HTTP status and Retry-After of an empty-body error response, so an empty 429 takes the throttle path instead of failing with "Unexpected end of JSON input". Retry transient failures (5xx, unreadable error bodies, connection resets) once before the first response chunk, with visible physical attempts. Usage records of failed LLM and embedding calls carry errorStatus and errorName (no message text); CSV exports include both. Cap single embedding inputs at 24000 characters by default (maxInputChars) and stop retrying input-too-long errors.

## 1.2.0

### Minor Changes

- 57766c7: Record the size of messages and tool definitions actually sent on every LLM request, and export request shape in usage CSV. DeepSeek and Ollama inherit the OpenAI provider change through internal dependency patch releases.
- Requires `@mcp-abap-adt/llm-agent` `^30.13.0`, whose `llm.call` declares the request-shape fields.

## 1.1.0

### Minor Changes

- 34cd979: Expose current unconfirmed delivery counts in usage recorder stats.
- Requires `@mcp-abap-adt/llm-agent` `^30.12.0`, whose `IUsageControl.stats()` declares `unconfirmed`.

## 1.0.0

- Add the usage recorder, delivery transports, memory and JSONL sinks, and shared readers and exports. First release.
