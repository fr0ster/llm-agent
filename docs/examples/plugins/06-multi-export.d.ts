/**
 * Plugin: multi-export — demonstrates a plugin that registers multiple types.
 *
 * A single plugin file can export any combination of:
 *   - stageHandlers     (pipeline stage handlers)
 *   - embedderFactories (RAG embedder factories)
 *   - reranker          (replaces default reranker)
 *   - queryExpander     (replaces default query expander)
 *   - outputValidator   (replaces default output validator)
 *
 * This example registers two stage handlers and a query expander.
 *
 * Usage in YAML:
 *   pluginDir: ./plugins
 *   pipeline:
 *     version: "1"
 *     stages:
 *       - { id: timing-start, type: request-timer-start }
 *       - { id: classify, type: classify }
 *       # ... other stages ...
 *       - { id: timing-end, type: request-timer-end }
 */
import type { ISpan, IStageHandler, PipelineContext } from '@mcp-abap-adt/llm-agent-server';
import type { CallOptions, IQueryExpander, RagError, Result } from '@mcp-abap-adt/llm-agent';
declare class RequestTimerStartHandler implements IStageHandler {
    execute(ctx: PipelineContext, _config: Record<string, unknown>, span: ISpan): Promise<boolean>;
}
declare class RequestTimerEndHandler implements IStageHandler {
    execute(ctx: PipelineContext, _config: Record<string, unknown>, span: ISpan): Promise<boolean>;
}
declare class DomainQueryExpander implements IQueryExpander {
    expand(query: string, _options?: CallOptions): Promise<Result<string, RagError>>;
}
export declare const stageHandlers: {
    'request-timer-start': RequestTimerStartHandler;
    'request-timer-end': RequestTimerEndHandler;
};
export declare const queryExpander: DomainQueryExpander;
export {};
//# sourceMappingURL=06-multi-export.d.ts.map