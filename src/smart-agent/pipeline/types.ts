/**
 * Pipeline DSL types — structured YAML pipeline definition.
 *
 * A structured pipeline describes the execution topology of the SmartAgent
 * as a tree of stages. Each stage has a type (built-in operation or control
 * flow construct), optional config, and optional condition (`when`).
 *
 * ## Stage types
 *
 * **Built-in operations** — correspond to pipeline phases:
 * - `classify`    — decompose user input into typed subprompts
 * - `summarize`   — condense conversation history (uses helper LLM)
 * - `rag-upsert`  — upsert classified subprompts to RAG stores
 * - `translate`   — translate non-ASCII RAG query to English
 * - `expand`      — expand query with synonyms (query expander)
 * - `rag-query`   — query a RAG store (config: { store: 'facts' | 'feedback' | 'state' })
 * - `rerank`      — re-score RAG results
 * - `tool-select` — select MCP tools based on RAG results
 * - `assemble`    — build final LLM context
 * - `tool-loop`   — streaming LLM call + tool execution loop
 *
 * **Control flow** — orchestrate child stages:
 * - `parallel` — run child stages concurrently, wait for all
 * - `repeat`   — repeat child stages until condition or max iterations
 *
 * ## Conditions
 *
 * The `when` field is a dot-path property lookup evaluated against the
 * pipeline context. Examples:
 * - `"shouldRetrieve"` — truthy check on `ctx.shouldRetrieve`
 * - `"config.classificationEnabled"` — truthy check on `ctx.config.classificationEnabled`
 *
 * ## Example
 *
 * ```yaml
 * pipeline:
 *   version: "1"
 *   stages:
 *     - id: classify
 *       type: classify
 *     - id: rag-retrieval
 *       type: parallel
 *       when: "shouldRetrieve"
 *       stages:
 *         - { id: query-facts, type: rag-query, config: { store: facts, k: 10 } }
 *         - { id: query-state, type: rag-query, config: { store: state, k: 10 } }
 *     - id: assemble
 *       type: assemble
 *     - id: tool-loop
 *       type: tool-loop
 * ```
 */

// ---------------------------------------------------------------------------
// Stage types
// ---------------------------------------------------------------------------

/**
 * Built-in stage types — each maps to an {@link IStageHandler} implementation
 * that reads from and writes to the {@link PipelineContext}.
 */
export type BuiltInStageType =
  | 'classify'
  | 'summarize'
  | 'rag-upsert'
  | 'translate'
  | 'expand'
  | 'rag-query'
  | 'rerank'
  | 'tool-select'
  | 'assemble'
  | 'tool-loop';

/**
 * Control flow stage types — orchestrate child stages without
 * performing domain logic themselves.
 */
export type ControlFlowType = 'parallel' | 'repeat';

/** Union of all recognized stage types. */
export type StageType = BuiltInStageType | ControlFlowType;

// ---------------------------------------------------------------------------
// Stage definition
// ---------------------------------------------------------------------------

/**
 * A single pipeline stage as parsed from structured YAML.
 *
 * Stages form a tree: control flow types (`parallel`, `repeat`) contain
 * child stages in their `stages` array. Leaf stages are built-in operations.
 */
export interface StageDefinition {
  /** Unique ID within the pipeline. Used for logging, tracing, and timing entries. */
  id: string;

  /** Stage type — either a built-in operation or a control flow construct. */
  type: StageType;

  /**
   * Arbitrary config passed to the stage handler.
   * Each handler defines its own expected config shape.
   *
   * Examples:
   * - rag-query: `{ store: 'facts', k: 10 }`
   * - tool-loop: `{ maxIterations: 10, maxToolCalls: 30 }`
   */
  config?: Record<string, unknown>;

  /**
   * Condition expression. When present, the stage is skipped if the
   * expression evaluates to falsy.
   *
   * The expression is a dot-path property lookup on the pipeline context.
   * Supports negation with `!` prefix.
   *
   * Examples: `"shouldRetrieve"`, `"!isAscii"`, `"config.queryExpansionEnabled"`
   */
  when?: string;

  /**
   * Child stages — used by `parallel` and `repeat` control flow types.
   * For `parallel`: all children run concurrently.
   * For `repeat`: children run sequentially in each iteration.
   */
  stages?: StageDefinition[];

  /**
   * Sequential follow-up stages — used by `parallel` type only.
   * These run sequentially after all parallel children complete.
   *
   * Example: run three RAG queries in parallel, then rerank sequentially.
   */
  after?: StageDefinition[];

  /** Maximum iterations — used by `repeat` type. Default: 10. */
  maxIterations?: number;

  /**
   * Stop condition — used by `repeat` type.
   * The loop stops when this expression evaluates to truthy.
   */
  until?: string;
}

// ---------------------------------------------------------------------------
// Pipeline definition
// ---------------------------------------------------------------------------

/**
 * Top-level structured pipeline definition.
 *
 * When present in the YAML config (`pipeline.stages`), the structured
 * pipeline replaces the default hardcoded execution flow in SmartAgent.
 * When absent, the default flow runs unchanged (full backwards compatibility).
 */
export interface StructuredPipelineDefinition {
  /** Schema version for forward compatibility. Currently only `'1'`. */
  version: '1';

  /** Ordered list of top-level stages. */
  stages: StageDefinition[];
}
