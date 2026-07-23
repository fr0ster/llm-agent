/**
 * Result of an MCP tool-catalog vectorization run.
 *
 * Declared HERE, in the leaf contracts package, rather than next to
 * vectorizeMcpTools: llm-agent must not depend on llm-agent-libs.
 */
export interface ToolCatalogStatus {
  /** Tools successfully listed across all MCP clients. */
  total: number;
  /** Tools whose write returned ok: true. */
  vectorized: number;
  /** Names of tools that failed to be written. */
  failed: string[];
  /** Clients whose listTools() failed; their tools never reached `total`. */
  clientFailures: number;
  /**
   * false when any client failed to list, or any listed tool failed.
   *
   * Health keys off THIS, not off `vectorized === total`: a client that could
   * not list contributes to neither counter, so the counters alone would read
   * as a complete catalog.
   */
  complete: boolean;
}

/**
 * Reports the last vectorization run. Deliberately TINY and SEPARATE from
 * ISmartAgent (ISP), detected via {@link isToolCatalogReporter}.
 */
export interface IToolCatalogReporter {
  /** undefined = nothing was attempted (no store, or a store with no writer). */
  getToolCatalogStatus(): ToolCatalogStatus | undefined;
}

/** Type guard: does `x` report tool-catalog status? */
export function isToolCatalogReporter(x: unknown): x is IToolCatalogReporter {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as IToolCatalogReporter).getToolCatalogStatus === 'function'
  );
}
