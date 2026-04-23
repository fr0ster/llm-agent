# Migrating to v11.0.0

v11.0.0 extracts every LLM provider, embedder, and Qdrant RAG into dedicated packages. All v10 back-compat re-exports are removed. Core dependencies shrink to `zod` only.

## What broke

- **No more back-compat re-exports.** Every symbol lives in exactly one package — import from its canonical home.
- **Non-Smart Agent hierarchy removed.** `OpenAIAgent`, `AnthropicAgent`, `DeepSeekAgent`, `SapCoreAIAgent`, `PromptBasedAgent`, and `BaseAgent` are deleted. Use `SmartAgent` + a provider directly.
- **Server provider dependencies are optional peers.** Install only the packages your `smart-server.yaml` names. Missing peer throws `MissingProviderError` at startup.
- **`@sap-ai-sdk/*` and `axios` are out of core.** Moved to the respective extracted packages.

## Install modes

### (a) Server-managed declarative (most common)

```bash
npm install @mcp-abap-adt/llm-agent-server \
            @mcp-abap-adt/deepseek-llm \
            @mcp-abap-adt/ollama-embedder
```

Install server + exactly the peers your `smart-server.yaml` references. Missing peer → `MissingProviderError` with install hint.

### (b) Programmatic server composition

Same install as (a), but your code constructs `SmartAgent` via `SmartAgentBuilder` directly (no declarative config). Import provider classes from their packages; pass instances to builder fluent setters.

### (c) Core-only (no SmartAgent, no server)

```bash
npm install @mcp-abap-adt/llm-agent
```

Build your own agent against the interfaces exported by core. Useful for specialized runtimes without SmartAgent/Builder/pipeline. No provider packages required — supply your own `ILlm` and `IEmbedder` implementations, or construct third-party provider instances directly from their packages.

## Symbol → package mapping

| Symbol | v10 location | v11 package |
|---|---|---|
| `SmartAgent`, `SmartAgentBuilder`, `DefaultPipeline` | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-server` (unchanged) |
| Pipeline handlers | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-server` (unchanged) |
| `OpenAIProvider`, `OpenAIConfig` | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/openai-llm` |
| `AnthropicProvider`, `AnthropicConfig` | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/anthropic-llm` |
| `DeepSeekProvider`, `DeepSeekConfig` | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/deepseek-llm` |
| `SapCoreAIProvider`, `SapCoreAIConfig`, `SapAICoreCredentials` | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/sap-aicore-llm` |
| `OpenAiEmbedder`, `OpenAiEmbedderConfig` | `@mcp-abap-adt/llm-agent` | `@mcp-abap-adt/openai-embedder` |
| `OllamaEmbedder`, `OllamaRag`, `OllamaEmbedderConfig` | `@mcp-abap-adt/llm-agent` | `@mcp-abap-adt/ollama-embedder` |
| `SapAiCoreEmbedder`, `SapAiCoreEmbedderConfig` | `@mcp-abap-adt/llm-agent` | `@mcp-abap-adt/sap-aicore-embedder` |
| `QdrantRag`, `QdrantRagProvider`, configs | `@mcp-abap-adt/llm-agent` | `@mcp-abap-adt/qdrant-rag` |
| `BaseLLMProvider`, `LLMProvider` type | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent` (moved to core — now provider-agnostic) |
| `FallbackRag`, `CircuitBreaker`, `RetryLlm`, `RateLimiterLlm` | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-server` (unchanged) |
| Interfaces (`IRag`, `ILlm`, `IEmbedder`, etc.) | `@mcp-abap-adt/llm-agent` | `@mcp-abap-adt/llm-agent` (unchanged) |
| `MCPClientWrapper` and transports | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-server` (unchanged) |
| `MissingProviderError` (NEW) | — | `@mcp-abap-adt/llm-agent` |
| `prefetchEmbedderFactories`, `builtInEmbedderFactories` (factory registry moved) | `@mcp-abap-adt/llm-agent` (embedder-factories) | `@mcp-abap-adt/llm-agent-server` |
| Agent hierarchy (`OpenAIAgent`, etc.) | `@mcp-abap-adt/llm-agent-server` | **REMOVED** — use `SmartAgent` + provider |

## Agent hierarchy removal

Before (v10):

```ts
import { OpenAIAgent } from '@mcp-abap-adt/llm-agent-server';

const agent = new OpenAIAgent({ apiKey, model });
const reply = await agent.chat(messages);
```

After (v11):

```ts
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-server';

const llm = new OpenAIProvider({ apiKey, model });
const agent = await new SmartAgentBuilder().withMainLlm(llm).build();
const reply = await agent.chat(messages);
```

`PromptBasedAgent` has no direct replacement — it was a test-only synthetic agent. Prompt-based tool-use with non-chat models is deferred (see issue #102).

## CLI changes

CLI commands (`llm-agent`, `llm-agent-check`, `claude-via-agent`) are unchanged from v10. They're still shipped by `@mcp-abap-adt/llm-agent-server`. The `--llm-only` mode now uses `SmartAgent` with `mcp.type: 'none'` (no behavioral change for consumers).

## MissingProviderError

When `smart-server.yaml` names a provider whose peer is not installed, startup fails fast:

```
MissingProviderError: Provider 'ollama' is declared in config but package '@mcp-abap-adt/ollama-embedder' is not installed. Run: npm install @mcp-abap-adt/ollama-embedder
```

Fix by installing the named peer. Config-validation catches the error before the pipeline is constructed.

## Dockerfile examples

`examples/docker-*/Dockerfile`s now install server + the specific peers their bundled `smart-server.yaml` uses. See the repo `examples/` directory for concrete snippets.
