/**
 * Pipeline configuration types for SmartServer.
 *
 * The legacy `PipelineConfig` shape is refused at load (assertNoLegacyPipelineConfig)
 * and read by nothing; what is left of it here is kept only until its remaining
 * members are retired with it.
 */

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface PipelineRagStoreConfig {
  /** 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector'. */
  type?: 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector';
  /**
   * Embedder name — resolved from the embedder factory registry.
   * Built-in: 'ollama', 'openai', 'sap-ai-core'. Consumers can register custom factories.
   * When omitted, defaults to 'ollama' for stores that require one.
   */
  embedder?: string;
  /** Base URL for embedding service or Qdrant server */
  url?: string;
  /** API key (for openai type or Qdrant auth) */
  apiKey?: string;
  /** Embedding model name */
  model?: string;
  /** Collection / table name (required for qdrant, hana-vector, pg-vector) */
  collectionName?: string;
  /** Cosine similarity dedup threshold. Default: 0.92 */
  dedupThreshold?: number;
  /** Weight for vector search (0..1). Default: 0.7 */
  vectorWeight?: number;
  /** Weight for keyword search (0..1). Default: 0.3 */
  keywordWeight?: number;
  /** Per-request timeout for embedding calls in milliseconds. Default: 30 000 */
  timeoutMs?: number;
  /** SAP AI Core resource group (used when embedder is 'sap-ai-core' / 'sap-aicore'). */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario for the embedding model deployment.
   * `'orchestration'` (default) uses the SAP SDK; `'foundation-models'` calls the REST inference API.
   */
  scenario?: 'orchestration' | 'foundation-models';
}

export interface PipelineConfig {
  /** RAG stores keyed by consumer-defined names. */
  rag?: Record<string, PipelineRagStoreConfig>;
  /** One or more MCP servers to connect to simultaneously. */
  mcp?: Array<{
    type: 'http' | 'stdio';
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
  }>;

  // -- Structured pipeline (optional) ----------------------------------------

  /**
   * Schema version for forward compatibility. Currently only `'1'`.
   * When present alongside `stages`, enables the structured pipeline executor.
   */
  version?: '1';
  /**
   * Structured pipeline stage definitions.
   * When present, the pipeline executor replaces the default hardcoded flow.
   * See `docs/ARCHITECTURE.md` for stage types and YAML examples.
   */
  stages?: import('@mcp-abap-adt/llm-agent-libs').StageDefinition[];
}
