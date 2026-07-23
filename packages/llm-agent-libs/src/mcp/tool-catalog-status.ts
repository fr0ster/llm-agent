import type {
  IToolCatalogReporter,
  ToolCatalogStatus,
} from '@mcp-abap-adt/llm-agent';

/**
 * Holds the last vectorization result. Written once by the builder, read by
 * HealthChecker through `isToolCatalogReporter`.
 *
 * Stays `undefined` when nothing was attempted — no tools RAG, or a store with
 * no writer. That is deliberately distinct from a summary reporting zero
 * vectorized tools, which means an attempt was made and failed.
 */
export class ToolCatalogStatusHolder implements IToolCatalogReporter {
  private status: ToolCatalogStatus | undefined;

  publish(status: ToolCatalogStatus): void {
    this.status = status;
  }

  getToolCatalogStatus(): ToolCatalogStatus | undefined {
    return this.status;
  }
}
