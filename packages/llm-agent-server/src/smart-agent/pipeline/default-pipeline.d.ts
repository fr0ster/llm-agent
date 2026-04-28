/**
 * DefaultPipeline — IPipeline implementation backed by PipelineExecutor + stage handlers.
 *
 * This is the standard pipeline used by SmartAgent when no custom pipeline is
 * configured. It runs one of two stage sequences, selected by
 * {@link SmartAgentConfig.enrichedToolSearch}:
 *
 * **Single-phase (default):**
 * ```text
 * classify → summarize → parallel(rag-query tools, rag-query history, rag-query <custom>…) →
 * rerank → skill-select → tool-select → assemble → tool-loop → history-upsert
 * ```
 *
 * **Enriched (`enrichedToolSearch: true`):** the tools RAG store is queried in
 * a second phase driven by context from prior retrieval + selected skills:
 * ```text
 * classify → summarize → parallel(rag-query history, rag-query <custom>…) →
 * rerank → skill-select → build-tool-query → rag-query tools (enriched) →
 * tool-select → assemble → tool-loop → history-upsert
 * ```
 *
 * Built-in RAG stores (`tools`, `history`) are wired from `toolsRag`/`historyRag` deps.
 * Additional custom stores can be passed via `ragStores` and are queried in parallel
 * with built-ins. Stores can be added/removed at runtime via `rebuildStages()`.
 */
import type { CallOptions, LlmStreamChunk, LlmTool, Message, Result } from '@mcp-abap-adt/llm-agent';
import type { OrchestratorError } from '../agent.js';
import type { IPipeline, PipelineDeps, PipelineResult } from '../interfaces/pipeline.js';
/**
 * Standard IPipeline implementation that orchestrates the default SmartAgent
 * request lifecycle via PipelineExecutor and built-in stage handlers.
 *
 * Usage:
 * ```ts
 * const pipeline = new DefaultPipeline();
 * pipeline.initialize(deps);
 * const result = await pipeline.execute(input, history, options, yieldChunk);
 * ```
 */
export declare class DefaultPipeline implements IPipeline {
    private deps;
    private executor;
    private stages;
    private resolvedTracer;
    private resolvedClassifier;
    private resolvedAssembler;
    private resolvedReranker;
    private resolvedQueryExpander;
    private resolvedToolCache;
    private resolvedOutputValidator;
    private resolvedSessionManager;
    private resolvedMetrics;
    private resolvedRequestLogger;
    private resolvedLlmCallStrategy;
    initialize(deps: PipelineDeps): void;
    execute(input: string | Message[], history: Message[], options: CallOptions | undefined, yieldChunk: (chunk: Result<LlmStreamChunk, OrchestratorError>) => void, externalTools?: LlmTool[]): Promise<PipelineResult>;
    rebuildStages(): void;
    /**
     * Build the fixed stage list. RAG parallel block only includes stores
     * that were provided in deps.
     */
    private _buildStages;
    /**
     * Create a PipelineContext from deps + per-request input.
     * Mirrors the pattern in SmartAgent._runStructuredPipeline().
     */
    private _buildContext;
}
//# sourceMappingURL=default-pipeline.d.ts.map