# LLM tool and skill retrievers — design

Date: 2026-11-24. Updated 2026-11-25 for skill retrieval.

## Goal

Select MCP tools and skills for a step without catalogue RAG searches. A cheap model reads the step text and each candidate catalogue and returns the names the step needs. The retrieval contracts let a consumer choose the selection strategy by configuration.

## Owner decisions

- The model sees name, description and input schema of every candidate tool.
- The model sees name and description of every skill returned by `ISkillManager.listSkills`.
- Use `rag` for both catalogues by default. Use `llm` to replace both catalogue searches with the configured cheap model. History and knowledge stores remain eligible for RAG retrieval.
- A selector failure ends the stage with a typed error and the usage of the failed call.
- The selector can return any number of candidate names. Prefer including an extra relevant candidate over leaving one out.

## RAG baseline

Tool selection uses `tool:` records and applies `IToolSelectionStrategy.select(results: RagResult[])`. Skill selection uses `skill:` records from all preloaded RAG results. If none are present, it queries all eligible stores with the existing RAG text and `k` before enumerating skills. A match loads the corresponding skill body from the manager. Hard mode also requires a match for skills.

## Contract

In `@mcp-abap-adt/llm-agent`:

```ts
export interface ToolCandidate {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ToolRetrievalRequest {
  readonly text: string;               // the step text the tools are for
  readonly candidates: readonly ToolCandidate[];
}

export interface ToolRetrievalResult {
  readonly names: readonly string[];   // subset of candidate names
  readonly usage?: LlmUsage;
}

export interface IToolRetriever {
  readonly name: string;
  retrieve(
    request: ToolRetrievalRequest,
    options?: CallOptions,             // signal, session logger, usage sink
  ): Promise<Result<ToolRetrievalResult, SmartAgentError>>;
}

export interface SkillCandidate {
  readonly name: string;
  readonly description: string;
}

export interface SkillRetrievalRequest {
  readonly text: string;
  readonly candidates: readonly SkillCandidate[];
}

export interface SkillRetrievalResult {
  readonly names: readonly string[];
  readonly usage?: LlmUsage;
}

export interface ISkillRetriever {
  readonly name: string;
  retrieve(
    request: SkillRetrievalRequest,
    options?: CallOptions,
  ): Promise<Result<SkillRetrievalResult, SmartAgentError>>;
}
```

Implementations:

- `RagToolRetriever` and `RagSkillRetriever` implement the default RAG behaviour.
- `LlmToolRetriever` and `LlmSkillRetriever` share the same selection core. Each makes one chat call to the configured `ILlm` with the full candidate catalogue sorted by name before the step text. The stable catalogue prefix supports provider prompt caching.
- The shared core validates JSON locally in `llm-agent-libs`. The answer shape is `{ tools: string[] }` or `{ skills: string[] }`, respectively. Invalid JSON, an invalid shape or a name outside the catalogue returns `TOOL_RETRIEVAL_INVALID` or `SKILL_RETRIEVAL_INVALID`.
- Usage is attributed once per call to the actual model and the role `tool-retriever` or `skill-retriever`.

## Pipeline

- `ToolSelectHandler` delegates selection to `ctx.toolRetriever ?? new RagToolRetriever(...)`.
- Candidates are `ctx.mcpTools` after the consumer's exposure filter (role allow-list) and before availability filtering. The exposure filter moves from the tools RAG wrapper to a candidate filter the consumer provides, so both retrievers see the same role-filtered set.
- `SkillSelectHandler` uses `ctx.skillRetriever` when supplied and `RagSkillRetriever` by default. It loads the content of selected skills in manager order and makes the selected skills available to downstream stages.
- Abort, model-context overflow and other typed failures end the stage with the original code and the usage of the failed call.
- The LLM selectors log the selected names and per-model token usage in `llm_tool_retrieval` and `llm_skill_retrieval`.
- The default pipeline omits `skippedRagStores` from generic `rag-query` stages and the request-time RAG view used by fallback searches. Use the `ragStores` keys for the dedicated catalogue stores, including `user/<name>` and `session/<name>` keys where applicable. Other stores are still queried normally. The built-in tool RAG stage and RAG tool-loop reselection are also suppressed whenever a tool retriever is supplied.

Configure the `llm` strategy with both retrievers and the catalogue store keys.

```ts
builder
  .withToolRetriever(new LlmToolRetriever(selectorLlm))
  .withSkillRetriever(new LlmSkillRetriever(selectorLlm))
  .withSkippedRagStores('tools', 'skills');
```

Standalone `DefaultPipeline` callers pass `toolRetriever`, `skillRetriever` and `skippedRagStores` in `PipelineDeps`.

## Hub

- Setting `toolRetrieval.strategy`: `rag` (default) | `llm`; `toolRetrieval.model`: the cheap model, no default. Read through the shared loader: config file < environment variable < launch parameter.
- `llm` without a model is a startup error.
- The hub passes the same configured model to both LLM retrievers and excludes each catalogue-only RAG store by key. The RAG configuration uses the default selectors and keeps its catalogue stores eligible.
- The hub passes the role allow-list as the candidate filter.

## Measurement

- Corpus: the hub tool corpus already used for R1–R3 (`tool-metrics`), plus the tutorial steps.
- Per strategy: hit@1 / recall of the expected tool, number of tools returned, tokens per model (input, cached input, output) and latency per step. Tokens are never summed across models.
- Baseline: R2 (hub corpus) hit@1 60.9%.

## Out of scope

- The tool cache (lookup/writer) from the 2026-11-14 tool cache fallback design. The LLM retriever is the universal fallback selector named there and can be reused by it later.
- Changing tool descriptions (owner fixes them in mcp-abap-adt).

## Open questions

- Catalogue size per call: with name + description + schema for the full role-filtered catalogue (about 230 tools for a writer role) the input is large; prompt caching keeps the repeated part cheap. Measure before deciding on any split.
