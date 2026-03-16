# Plugin Examples

Example plugin files for `@mcp-abap-adt/llm-agent`. Copy any of these into your plugin directory to extend the agent.

## Plugin directories (load order, later wins)

1. `~/.config/llm-agent/plugins/` — user-level
2. `./plugins/` — project-level (relative to cwd)
3. `--plugin-dir <path>` or `pluginDir` in YAML

## Examples

| File | Type | Description |
|------|------|-------------|
| [`01-audit-log.ts`](01-audit-log.ts) | `stageHandlers` | Logs every request for auditing. Configurable log level and text truncation. |
| [`02-content-filter.ts`](02-content-filter.ts) | `outputValidator` | Blocks LLM responses containing passwords, credit cards, private keys, or AWS keys. |
| [`03-score-reranker.ts`](03-score-reranker.ts) | `reranker` | Boosts RAG results by metadata prefix (tools, state, feedback) and recency. |
| [`04-rate-limiter.ts`](04-rate-limiter.ts) | `stageHandlers` | Sliding-window rate limiter per session. Configurable max requests and window size. |
| [`05-custom-embedder.ts`](05-custom-embedder.ts) | `embedderFactories` | Registers a Cohere embedding provider, selectable via `rag.embedder: cohere` in YAML. |
| [`06-multi-export.ts`](06-multi-export.ts) | `stageHandlers` + `queryExpander` | Shows how one file can register multiple export types (timer stages + domain synonyms). |

## Supported exports

```ts
export interface PluginExports {
  stageHandlers?: Record<string, IStageHandler>;    // pipeline stages
  embedderFactories?: Record<string, EmbedderFactory>; // RAG embedders
  reranker?: IReranker;                              // replaces default
  queryExpander?: IQueryExpander;                     // replaces default
  outputValidator?: IOutputValidator;                 // replaces default
}
```

Only `.js`, `.mjs`, and `.ts` files are loaded. Subdirectories are ignored.
