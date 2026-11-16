# Provider prompt caching

The goal is to enable documented provider caching and preserve its usage evidence.
This change does not benchmark latency, cost, or hit rates. Cache availability,
minimum prefix length, routing, and retention remain provider/model dependent.

## Provider behavior

| Provider | Requests | Cache usage |
| --- | --- | --- |
| Anthropic | Raw axios chat and fetch SSE requests include top-level `cache_control: {type: 'ephemeral', ttl: '5m'}` by default. `1h` selects the longer TTL; `off` omits the directive. The automatic breakpoint follows the last cacheable block as history grows. | `cache_read_input_tokens` and `cache_creation_input_tokens`. |
| OpenAI | Chat Completions caches eligible prefixes automatically. Optional `prompt_cache_key` and `prompt_cache_retention` are forwarded only for OpenAI. | `prompt_tokens_details.cached_tokens`; `cache_write_tokens` is preserved as creation usage when supplied. |
| DeepSeek | Prefix caching is automatic; no cache activation parameter is needed. OpenAI-only controls are omitted. | `prompt_cache_hit_tokens` (the existing OpenAI-compatible details field also works). Cache misses are ordinary input, not a reported cache-creation count. |
| SAP AI Core orchestration | Existing standalone `SapCoreAIConfig.promptCaching: 'off' | 'system' | 'system+tools'` adds explicit breakpoints to the last system content part and optionally last tool for Anthropic models. Default remains off. | Existing `prompt_tokens_details.cached_tokens` and `cache_creation_tokens` mapping is retained. |
| Ollama | Uses the OpenAI-compatible endpoint. No new cache request parameter. Native `/api/chat` and `/api/generate` `keep_alive` controls how long a model stays loaded in memory; it is not a provider prompt-cache contract. | Preserve compatible cached-token reports if returned; do not infer cache hits from model residency. |

SAP documents explicit content/tool breakpoints for Bedrock-hosted Anthropic and
Nova. Its documentation does not establish forwarding Anthropic's top-level
automatic `cache_control` or the direct-provider TTL contract through this
integration. Those controls are therefore not added to orchestration. The existing
SAP-only explicit modes remain available through `SapCoreAIConfig`, independently
of the new Anthropic server setting.

OpenAI recommends stable cache keys for related requests on earlier models;
newer models route automatically and can use keys for separate accounting.
Retention is optional and model dependent: select `in_memory` or `24h` only when
supported by the chosen model and retention policy. No retention value or key is
invented by the library. Current documentation also describes newer Responses API
cache controls; this adapter continues using Chat Completions.

Sources: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Chat Completions parameters](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/),
[SAP orchestration prompt caching](https://sap.github.io/ai-sdk/docs/python/examples/orchestration-service2#prompt-caching),
[Ollama model residency](https://docs.ollama.com/faq#how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately).
Anthropic behavior follows the supplied bundled `shared/prompt-caching.md` and
TypeScript README's **Automatic Caching (Recommended)** section.

## Configuration contract

The same precedence as temperature applies: `options.x ?? this.config.x`.
`AnthropicConfig.promptCaching`, `LLMCallOptions.promptCaching`, and
`CallOptions.promptCaching` accept `5m`, `1h`, or `off`. Omission enables the
Anthropic provider's 5-minute default. A per-call `off` disables an enabled config;
a per-call TTL enables an `off` config. OpenAI's corresponding fields are
`promptCacheKey?: string` and `promptCacheRetention?: 'in_memory' | '24h'`.

Flat `llm` YAML and named `llm.main` / role entries preserve these fields. The
composition root (`createMakeLlm`, injected into SmartServer) forwards the relevant
fields to each provider. Adapters preserve them on chat and streaming paths;
internal roles retain their existing restriction on client generation overrides.
The HTTP chat route accepts the camelCase fields above and the OpenAI wire aliases
`prompt_cache_key` / `prompt_cache_retention`. Invalid values fail at the YAML/HTTP
boundary. When both spellings are supplied, the wire alias takes precedence.

```yaml
llm:
  provider: anthropic
  model: ${ANTHROPIC_MODEL}
  credentialRef: ANTHROPIC
  promptCaching: 5m  # default; 1h or off
```

For OpenAI, use `provider: openai`, a configured model and credential, and optionally
`promptCacheKey: shared-instructions-v1` / `promptCacheRetention: 24h`.
Do not use a new request UUID as the cache key. Provider-specific fields are not
forwarded to DeepSeek, Ollama, or SAP.

## Usage and later verification

- `cachedInputTokens` records reads; `cacheCreationInputTokens` records writes.
  Both remain optional so old records and providers without these reports work.
- Anthropic usage records retain `inputTokens` as the provider's uncached remainder.
  Normalized `promptTokens` includes input + creation + reads, and `totalTokens`
  includes that full prompt plus output. OpenAI/DeepSeek/SAP prompt totals already
  include cached input; cache counters must not be added to them again.
- Cache counters survive normalized responses, stream bridges, token sums, request
  summaries (per model/component/category), controller logs, and JSONL/CSV export.
- SQLite, PostgreSQL, and HANA store complete records in `record_json`
  (TEXT/TEXT/NCLOB). These optional fields require no new column, migration, or
  schema-version bump. Shared reader conformance covers cached and legacy records.

To verify later with real traffic, use an eligible model, a sufficiently long
identical tools/system/history prefix, and sequential requests within the TTL.
Inspect each physical `llm.call` record and raw provider usage: first writes may
produce creation tokens, later requests should produce reads. Streaming reports
Anthropic input/cache usage at `message_start` and output at `message_delta`;
early closure retains the counts already received. Zero cache counters can mean a
short prompt, cold/expired cache, changed prefix, or provider routing. Diff actual
serialized request prefixes before interpreting a miss. No effectiveness claim is
made from mocked tests.

## Prefix stability audit

Searched `llm-agent-libs` for `Date.now`, `new Date`, `randomUUID`, `Math.random`,
request/session/trace IDs, tool assembly, sorting, and concurrent list operations.

- `context/context-assembler.ts` builds the system prefix from configured preamble,
  static tool guidance, and optional reasoning guidance. No per-call timestamp or
  random ID is inserted into that system prefix.
- `context/request-time.ts` keeps static time guidance in system and prepends the
  request's timestamp to the **last user message**, using `requestStartedAt`.
  This changes the suffix at that user turn (including when context is prepended),
  not the preceding history. It is intentional request context and is preserved.
- `agent.ts` generates trace/session IDs for correlation and scoping; these are not
  interpolated into the default system prompt. Tool-call IDs occur in history and
  must be replayed unchanged. Custom prompts may still contain volatile content.
- `mcp/tool-registry.ts` and `pipeline/handlers/tool-select.ts` use
  `Promise.allSettled`, whose results preserve configured client order. Server
  tool-list order is preserved, not sorted canonically. Providers/bridges likewise
  preserve offered-tool order; an upstream list that reorders changes the prefix.
- RAG tool selection, tool availability filtering, and per-iteration re-selection
  can intentionally change the tool set. Tools precede system/history in provider
  rendering, so these changes can invalidate the whole prefix. No clear random
  ordering bug was found; reordering or freezing selection would change behavior.
- `coordinator/stepper/cyclic-react-executor.ts` pins a rendered task specification
  in system once per run. It is stable inside that run but differs across tasks.
  `coordinator/planning/replan-on-error.ts` embeds the original request, results,
  remaining steps, and available agents into system; replans therefore have a
  changing system prefix. These serve existing task semantics and are not moved.
  Dialogue planner prompt composition adds static guidance; board/task IDs and
  generated metadata appear in runtime state, tool results, or later context.
- The assembler's recency window, summaries, retrieved text, recent actions, and
  context budgeting can edit history or the last user turn. Stable system/tools
  still help, but the affected history suffix cannot be assumed reusable.

No prefix-assembly behavior was changed: the findings are intentional dynamic
inputs or upstream ordering contracts, not clear bugs.
