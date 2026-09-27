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

export interface PipelineConfig {
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
