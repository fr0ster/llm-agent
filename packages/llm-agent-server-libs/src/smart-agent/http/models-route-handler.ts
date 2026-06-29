import type { RouteContext } from './route-table.js';

/**
 * GET /v1/models | /models — list LLM models available through this server.
 *
 * Body moved verbatim from `SmartServer._buildRouteTable` (route index 0).
 * Reads only `rc.rawUrl`, `rc.modelProvider`, and `rc.res` — no private server
 * fields, so no threading is required.
 */
export async function handleModelsList(rc: RouteContext): Promise<void> {
  const queryString = rc.rawUrl.includes('?') ? rc.rawUrl.split('?')[1] : '';
  const queryParams = new URLSearchParams(queryString);
  const excludeEmbedding = queryParams.get('exclude_embedding') === 'true';
  let data: Array<Record<string, unknown>> = [
    { id: 'smart-agent', object: 'model', owned_by: 'smart-agent' },
  ];
  if (rc.modelProvider) {
    const result = await rc.modelProvider.getModels({ excludeEmbedding });
    if (result.ok) {
      data = result.value.map((m) => ({
        id: m.id,
        object: 'model',
        owned_by: m.owned_by ?? 'unknown',
        ...(m.displayName ? { display_name: m.displayName } : {}),
        ...(m.provider ? { provider: m.provider } : {}),
        ...(m.capabilities ? { capabilities: m.capabilities } : {}),
        ...(m.contextLength ? { context_length: m.contextLength } : {}),
        ...(m.streamingSupported !== undefined
          ? { streaming_supported: m.streamingSupported }
          : {}),
        ...(m.deprecated !== undefined ? { deprecated: m.deprecated } : {}),
      }));
    }
  }
  rc.res.writeHead(200, { 'Content-Type': 'application/json' });
  rc.res.end(JSON.stringify({ object: 'list', data }));
}

/**
 * GET /v1/embedding-models | /embedding-models — list embedding models.
 *
 * Body moved verbatim from `SmartServer._buildRouteTable` (route index 1).
 * Reads only `rc.modelProvider` and `rc.res`.
 */
export async function handleEmbeddingModelsList(
  rc: RouteContext,
): Promise<void> {
  let data: Array<Record<string, unknown>> = [];
  if (rc.modelProvider?.getEmbeddingModels) {
    const result = await rc.modelProvider.getEmbeddingModels();
    if (result.ok) {
      data = result.value.map((m) => ({
        id: m.id,
        object: 'model',
        owned_by: m.owned_by ?? 'unknown',
        ...(m.displayName ? { display_name: m.displayName } : {}),
        ...(m.provider ? { provider: m.provider } : {}),
        ...(m.capabilities ? { capabilities: m.capabilities } : {}),
        ...(m.contextLength ? { context_length: m.contextLength } : {}),
        ...(m.streamingSupported !== undefined
          ? { streaming_supported: m.streamingSupported }
          : {}),
        ...(m.deprecated !== undefined ? { deprecated: m.deprecated } : {}),
      }));
    }
  }
  rc.res.writeHead(200, { 'Content-Type': 'application/json' });
  rc.res.end(JSON.stringify({ object: 'list', data }));
}
