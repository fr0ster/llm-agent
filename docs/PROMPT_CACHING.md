# Provider prompt caching

The shared contract carries only `promptCaching?: boolean`. Caching is enabled by
default; providers own the mechanism, placement, lifetime, and eligibility.
This change does not benchmark latency, cost, or hit rates.

## Configuration contract

`CallOptions`, `LLMCallOptions`, provider config, server config, flat `llm` YAML,
and named `llm.main` / role entries use the same boolean switch. Precedence is
`options.promptCaching ?? config.promptCaching ?? true`. A per-call `false`
disables an enabled config; a per-call `true` enables a disabled config.

SmartServer and its composition root (`createMakeLlm`) forward the switch to each
provider. Adapters preserve it for chat and streams; internal roles retain their
existing restriction on client generation overrides. HTTP chat requests accept
`promptCaching: true` or `promptCaching: false`. YAML and HTTP reject non-boolean
values, including string booleans and former string modes. Omission preserves the
provider default. Cache keys, retention controls, TTL options, and HTTP aliases for
provider cache parameters are not part of this contract.

```yaml
llm:
  provider: anthropic
  model: ${ANTHROPIC_MODEL}
  credentialRef: ANTHROPIC
  promptCaching: true  # default; false disables client-controlled caching
```

Named entries use the same field:

```yaml
llm:
  main:
    provider: sap-ai-sdk
    model: anthropic--claude-4-opus
    credentialRef: SAP
    promptCaching: true
  helper:
    provider: anthropic
    model: ${ANTHROPIC_MODEL}
    credentialRef: ANTHROPIC
    promptCaching: false
```

## Provider behavior

| Provider | Requests | Cache usage |
| --- | --- | --- |
| Anthropic | Enabled chat and streams include top-level `cache_control: { type: 'ephemeral' }` using the provider's documented default TTL. `false` omits the directive. No TTL option is exposed. The automatic breakpoint follows the last cacheable block as history grows. | `cache_read_input_tokens` and `cache_creation_input_tokens`. |
| SAP AI Core orchestration | For Anthropic Claude models, enabled chat and streams add explicit ephemeral breakpoints to the last system content block and last tool definition. `false` omits these markers. Other models receive no added markers. Placement is internal; no top-level automatic directive or TTL is sent. | `prompt_tokens_details.cached_tokens` and `cache_creation_tokens`. |
| OpenAI | Eligible prefixes are cached automatically. The switch has no request effect: the client cannot disable provider caching. No cache parameters are sent. | `prompt_tokens_details.cached_tokens`; `cache_write_tokens` is preserved as creation usage when supplied. |
| DeepSeek | Prefix caching is automatic. The switch has no request effect: the client cannot disable provider caching. No cache parameters are sent. | `prompt_cache_hit_tokens` (the existing OpenAI-compatible details field also works). Cache misses are ordinary input, not a reported cache-creation count. |
| Ollama | The switch has no request effect. No cache parameters are sent to the OpenAI-compatible endpoint. Native `keep_alive` controls model residency, which is separate from prompt caching. | Preserve compatible cached-token reports if returned; do not infer cache hits from model residency. |

Sources: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[SAP orchestration prompt caching](https://sap.github.io/ai-sdk/docs/python/examples/orchestration-service2#prompt-caching),
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/),
[Ollama model residency](https://docs.ollama.com/faq#how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately).

## SAP migration (major release)

`SapCoreAIConfig.promptCaching` now accepts a boolean. Replace the former disabled
mode with `false`, and either former enabled mode with `true`. System-only placement
is no longer selectable: the provider chooses system and tool breakpoints.
Omission now enables caching; set `false` explicitly to retain the previous
disabled default. Per-call overrides now use the same boolean and precedence as
the other providers. Cache usage reporting is unchanged.

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
