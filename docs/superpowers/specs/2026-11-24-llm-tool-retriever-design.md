# LLM tool retriever — design

Date: 2026-11-24. Status: draft for owner review.

## Goal

Select MCP tools for a step without a RAG search. A cheap model reads the step text and the candidate tools (name, description, input schema) and returns the tools the step needs. The selector is one implementation of a tool-retrieval contract, so a consumer swaps RAG search for it by configuration.

## Owner decisions

- The model sees name, description and input schema of every candidate tool.
- The LLM selector replaces RAG tool search; it is not layered on top of it. One strategy per configuration: `rag` or `llm`.
- One failure policy for the whole system: a selector failure is a typed error to the caller. No silent fallback to RAG.
- No caps: the model may return any number of tools. Better an extra tool than a missing one.

## Today

`ToolSelectHandler` (`packages/llm-agent-libs/src/pipeline/handlers/tool-select.ts`) lists MCP tools, embeds the query text, queries the RAG stores, keeps records whose id has the `tool:` prefix, and applies `IToolSelectionStrategy.select(results: RagResult[])`. That strategy only filters RAG results; it cannot replace the search.

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
```

Implementations:

- `RagToolRetriever` (llm-agent-libs): today's behaviour moved behind the contract: embed `text`, query the tool stores, map `tool:` records to names, apply `IToolSelectionStrategy`. Default, so nothing changes for existing consumers.
- `LlmToolRetriever` (llm-agent-libs): one call to a configured `ILlm`.
  - System prompt: select every tool the step may need; prefer including a tool over leaving one out; answer only with names from the list.
  - The candidate catalogue goes first and stays byte-stable between calls (sorted by name), so provider prompt caching applies; the step text goes last.
  - JSON answer validated in `llm-agent-libs` (no dependency on `typesafe-decision`). The answer has the shape `{ tools: string[] }`. Names outside the candidate list return `TOOL_RETRIEVAL_INVALID`.
  - Usage is reported per call and attributed to the role `tool-retriever` with its model.

## Pipeline

- `ToolSelectHandler` calls `ctx.toolRetriever ?? new RagToolRetriever(...)` instead of querying the stores itself.
- Candidates are `ctx.mcpTools` after the consumer's exposure filter (role allow-list) and before availability filtering. The exposure filter moves from the tools RAG wrapper to a candidate filter the consumer provides, so both retrievers see the same role-filtered set.
- Abort, model-context overflow and other typed failures end the stage with that error; usage of a failed call is kept.
- Session log: `tools_selected` gains `retriever: name`, and for the LLM retriever the selected names and token usage per model.

Builder: `withToolRetriever(retriever: IToolRetriever)`.

## Hub

- Setting `toolRetrieval.strategy`: `rag` (default) | `llm`; `toolRetrieval.model`: the cheap model, no default. Read through the shared loader: config file < environment variable < launch parameter.
- `llm` without a model is a startup error.
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
