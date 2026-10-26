# @mcp-abap-adt/llm-usage

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
