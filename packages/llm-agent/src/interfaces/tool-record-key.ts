/**
 * Strategy for the RAG record id under which an MCP tool is stored.
 *
 * A variation point the consumer owns: the default gives a working,
 * collision-free key, and a consumer who knows its servers (real names, a
 * per-server collection layout, or a faster-but-conflicting scheme) swaps in
 * its own. The engine stays MCP-agnostic — it never assumes a fixed server set.
 */
export interface ToolKeyContext {
  /** The tool's own name, as exposed by its MCP server. */
  toolName: string;
  /**
   * Zero-based index of the client this tool came from. One MCP server maps to
   * exactly one client, so within a boot this identifies the server. Stable for
   * the run; not durable across restarts if the configured order changes.
   */
  clientIndex: number;
  /** Total number of connected MCP clients this run. */
  clientCount: number;
}

export interface IToolRecordKey {
  /** The record id for a tool. Must be stable for a given (name, server). */
  key(ctx: ToolKeyContext): string;
}

/**
 * Default: a single MCP server keeps the historical `tool:${name}` key, so
 * existing single-server collections are unchanged. With two or more servers
 * the client index disambiguates, so identically named tools from different
 * servers no longer overwrite each other.
 */
export const defaultToolRecordKey: IToolRecordKey = {
  key({ toolName, clientIndex, clientCount }): string {
    return clientCount <= 1
      ? `tool:${toolName}`
      : `tool:${clientIndex}:${toolName}`;
  },
};
