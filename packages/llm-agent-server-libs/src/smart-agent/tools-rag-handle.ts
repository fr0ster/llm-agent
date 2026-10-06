import {
  type CallOptions,
  type IMcpClient,
  type IQueryEmbedder,
  type IRag,
  type IToolsRagHandle,
  type LlmTool,
  McpError,
  QueryEmbedding,
  toolNameFromRecord,
} from '@mcp-abap-adt/llm-agent';

/**
 * Build a real IToolsRagHandle over the tools RAG store + MCP catalog,
 * dispatching over the ALREADY-RESOLVED `clients`. Eagerly populates the
 * catalog so the SYNC `lookup(name)` contract returns a schema before any
 * `query()` runs. A catalog-load failure caches nothing: the eager load logs
 * it, and every `query()` lists again and rejects with the client's McpError
 * (spec §10.5.3 M9).
 */
export async function makeToolsRagHandle(
  clients: IMcpClient[],
  toolsRag: IRag | undefined,
  resolvedEmbedder: IQueryEmbedder | undefined,
  log?: (event: Record<string, unknown>) => void,
  namespaced?: { namespacedTools: readonly LlmTool[] },
): Promise<IToolsRagHandle> {
  const stepperMcpClients = clients ?? [];
  let catalogCache: Map<string, LlmTool> | undefined;
  const ensureCatalog = async (): Promise<Map<string, LlmTool>> => {
    if (catalogCache) return catalogCache;
    const catalog = new Map<string, LlmTool>();
    if (namespaced) {
      // A pre-built snapshot is authoritative: key the catalog by the EXPOSED
      // (namespaced) name so a namespaced RAG record maps back to it. Do NOT
      // also list clients bare here — that would reintroduce bare/exposed
      // name collisions this snapshot was built to resolve.
      for (const t of namespaced.namespacedTools) {
        if (!catalog.has(t.name)) catalog.set(t.name, t);
      }
    } else {
      // Spec §10.5.3 M9: a client that cannot list its tools is an error —
      // the first failure is thrown and nothing is cached, so the next query
      // lists again.
      const settled = await Promise.allSettled(
        stepperMcpClients.map((client) => client.listTools()),
      );
      for (const entry of settled) {
        if (entry.status === 'rejected') {
          const reason = entry.reason;
          throw reason instanceof McpError
            ? reason
            : new McpError(
                reason instanceof Error ? reason.message : String(reason),
                'MCP_ERROR',
              );
        }
        if (!entry.value.ok) throw entry.value.error;
      }
      for (const entry of settled) {
        if (entry.status !== 'fulfilled' || !entry.value.ok) continue;
        for (const t of entry.value.value) {
          if (!catalog.has(t.name)) catalog.set(t.name, t as LlmTool);
        }
      }
    }
    catalogCache = catalog;
    return catalog;
  };
  const handle: IToolsRagHandle = {
    async query(text: string, k?: number, options?: CallOptions) {
      const limit = k ?? 20;
      const catalog = await ensureCatalog();
      if (toolsRag && resolvedEmbedder) {
        // Pass options (requestLogger + trace) so the wrapped embedder logs
        // this query-embedding against the request — and to the store, so a
        // retrieval strategy's reranker gets the request's signal,
        // requestLogger and sessionLogger (§13.4).
        const embedding = new QueryEmbedding(text, resolvedEmbedder, options);
        const ragResult = await toolsRag.query(embedding, limit, options);
        // Spec §10.5.3 M9: a failed query is its RagError; zero hits is an
        // honest empty answer — never an unranked catalog prefix.
        if (!ragResult.ok) throw ragResult.error;
        const hits: LlmTool[] = [];
        for (const r of ragResult.value) {
          const name = toolNameFromRecord(r.metadata);
          if (name !== undefined) {
            const tool = catalog.get(name);
            if (tool) hits.push(tool);
          }
        }
        return hits;
      }
      // No tools store configured: the catalog itself is the answer.
      return [...catalog.values()].slice(0, limit);
    },
    lookup(name: string) {
      return catalogCache?.get(name);
    },
  };

  // F2: eagerly populate the MCP tool catalog at startup (MCP is connected
  // above), so the SYNC `lookup(name)` contract (IToolsRagHandle.lookup) returns
  // a tool schema BEFORE any `query()` runs. `ensureCatalog` is idempotent —
  // later `query()` calls reuse the cached map. Guard against a catalog-load
  // failure so startup never crashes: on failure `catalogCache` stays unset and
  // `lookup` returns undefined (today's worst case), while the happy path works.
  try {
    await ensureCatalog();
  } catch (err) {
    log?.({
      event: 'tools_catalog_eager_load_failed',
      message:
        'tools catalog eager-load failed; lookup() returns undefined until first query()',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return handle;
}
