/**
 * Pipeline DSL types — structured pipeline definition.
 *
 * A structured pipeline describes the execution topology of the SmartAgent
 * as a tree of stages. Each stage has a type (built-in operation or control
 * flow construct), optional config, and optional condition (`when`).
 */
/**
 * Built-in stage types — each maps to an IStageHandler implementation.
 */
export type BuiltInStageType = 'classify' | 'summarize' | 'translate' | 'expand' | 'rag-query' | 'rerank' | 'tool-select' | 'skill-select' | 'build-tool-query' | 'assemble' | 'tool-loop' | 'history-upsert';
/**
 * Control flow stage types — orchestrate child stages without
 * performing domain logic themselves.
 */
export type ControlFlowType = 'parallel' | 'repeat';
/** Union of all recognized stage types. */
export type StageType = BuiltInStageType | ControlFlowType;
/**
 * A single pipeline stage as parsed from structured YAML.
 */
export interface StageDefinition {
    /** Unique ID within the pipeline. Used for logging, tracing, and timing entries. */
    id: string;
    /** Stage type — either a built-in operation or a control flow construct. */
    type: StageType;
    /**
     * Arbitrary config passed to the stage handler.
     * Each handler defines its own expected config shape.
     */
    config?: Record<string, unknown>;
    /**
     * Condition expression. When present, the stage is skipped if the
     * expression evaluates to falsy.
     */
    when?: string;
    /**
     * Child stages — used by `parallel` and `repeat` control flow types.
     */
    stages?: StageDefinition[];
    /**
     * Sequential follow-up stages — used by `parallel` type only.
     */
    after?: StageDefinition[];
    /** Maximum iterations — used by `repeat` type. Default: 10. */
    maxIterations?: number;
    /**
     * Stop condition — used by `repeat` type.
     */
    until?: string;
}
//# sourceMappingURL=pipeline.d.ts.map