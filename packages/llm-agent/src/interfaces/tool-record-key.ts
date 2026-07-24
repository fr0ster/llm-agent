/**
 * Strategy for the RAG record id under which an MCP tool is stored.
 *
 * A variation point the consumer owns: the default gives a working,
 * collision-free key, and a consumer who knows its servers (real names, a
 * per-server collection layout, or a faster-but-conflicting scheme) swaps in
 * its own — provided the id keeps the `tool:` prefix (see `key`). The engine
 * stays MCP-agnostic — it never assumes a fixed server set.
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
  /**
   * The record id for a tool. Must be stable for a given (name, server), and
   * must start with `tool:` — retrieval uses that prefix to tell tool records
   * apart from skill records (`skill:`) in the same store. The tool name is
   * stored in metadata separately, so anything after `tool:` is free.
   */
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

/**
 * Recover a tool's name from a stored record, independent of the key scheme.
 *
 * The name is written into record metadata at vectorization time, so this
 * works for ANY {@link IToolRecordKey} — including a consumer's custom scheme —
 * without parsing the id. The id parse is a fallback for records written before
 * the name was stored, and it understands both default forms (`tool:name` and
 * `tool:<index>:name`).
 *
 * Returns `undefined` for a record that is not a tool (no `tool:` id).
 */
export function toolNameFromRecord(meta: {
  id?: unknown;
  name?: unknown;
}): string | undefined {
  const id = meta?.id;
  if (typeof id !== 'string' || !id.startsWith('tool:')) return undefined;
  if (typeof meta.name === 'string' && meta.name.length > 0) return meta.name;
  const rest = id.slice(5);
  // Default multi-server form `tool:<index>:<name>` — a numeric first segment is
  // the client index, so the name follows it.
  const indexed = /^\d+:(.*)$/.exec(rest);
  if (indexed) return indexed[1];
  // Otherwise the historical `tool:<name>[:<suffix>]` form — name comes first.
  return rest.replace(/:.*$/, '');
}
