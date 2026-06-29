import {
  type CallOptions,
  type IEmbedder,
  type IMcpClient,
  type IRag,
  type IToolsRagHandle,
  type LlmTool,
  QueryEmbedding,
} from '@mcp-abap-adt/llm-agent';

/**
 * Build a real IToolsRagHandle over the tools RAG store + MCP catalog,
 * dispatching over the ALREADY-RESOLVED `clients`. Eagerly populates the
 * catalog so the SYNC `lookup(name)` contract returns a schema before any
 * `query()` runs; a catalog-load failure is swallowed (logged) so startup
 * never crashes. Extracted verbatim from SmartServer.buildToolsRagHandle.
 */
export async function makeToolsRagHandle(
  clients: IMcpClient[],
  toolsRag: IRag | undefined,
  resolvedEmbedder: IEmbedder | undefined,
  log?: (event: Record<string, unknown>) => void,
): Promise<IToolsRagHandle> {
  const stepperMcpClients = clients ?? [];
  let catalogCache: Map<string, LlmTool> | undefined;
  const ensureCatalog = async (): Promise<Map<string, LlmTool>> => {
    if (catalogCache) return catalogCache;
    const catalog = new Map<string, LlmTool>();
    await Promise.allSettled(
      stepperMcpClients.map(async (client) => {
        const result = await client.listTools();
        if (result.ok) {
          for (const t of result.value) {
            if (!catalog.has(t.name)) catalog.set(t.name, t as LlmTool);
          }
        }
      }),
    );
    catalogCache = catalog;
    return catalog;
  };
  const handle: IToolsRagHandle = {
    async query(text: string, k?: number, options?: CallOptions) {
      const limit = k ?? 20;
      const catalog = await ensureCatalog();
      if (toolsRag && resolvedEmbedder) {
        // Pass options (requestLogger + trace) so the wrapped embedder logs
        // this query-embedding against the request.
        const embedding = new QueryEmbedding(text, resolvedEmbedder, options);
        const ragResult = await toolsRag.query(embedding, limit);
        if (ragResult.ok) {
          const hits: LlmTool[] = [];
          for (const r of ragResult.value) {
            const id = r.metadata.id as string | undefined;
            if (id?.startsWith('tool:')) {
              const name = id.slice(5).replace(/:.*$/, '');
              const tool = catalog.get(name);
              if (tool) hits.push(tool);
            }
          }
          if (hits.length > 0) return hits;
        }
      }
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
