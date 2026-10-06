import { type IModelProvider, SmartAgentError } from '@mcp-abap-adt/llm-agent';
import { jsonError } from './response-helpers.js';
import type { RouteContext } from './route-table.js';

/** A listing that threw, as the message and code `writeListingFailed` sends. */
function thrownError(err: unknown): { message: string; code?: string } {
  return {
    message: err instanceof Error ? err.message : String(err),
    code: err instanceof SmartAgentError ? err.code : undefined,
  };
}

/**
 * A provider that could not list its models — an `ok: false` result or a
 * rejection (spec §10.5.6 L7): 502 with the
 * provider's message and code — never 200 with a placeholder or `[]`.
 */
function writeListingFailed(
  rc: RouteContext,
  error: { message: string; code?: string },
): void {
  rc.res.writeHead(502, { 'Content-Type': 'application/json' });
  rc.res.end(jsonError(error.message, 'api_error', error.code));
}

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
    let result: Awaited<ReturnType<IModelProvider['getModels']>>;
    try {
      result = await rc.modelProvider.getModels({ excludeEmbedding });
    } catch (err) {
      writeListingFailed(rc, thrownError(err));
      return;
    }
    if (!result.ok) {
      writeListingFailed(rc, result.error);
      return;
    }
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
    let result: Awaited<
      ReturnType<NonNullable<IModelProvider['getEmbeddingModels']>>
    >;
    try {
      result = await rc.modelProvider.getEmbeddingModels();
    } catch (err) {
      writeListingFailed(rc, thrownError(err));
      return;
    }
    if (!result.ok) {
      writeListingFailed(rc, result.error);
      return;
    }
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
  rc.res.writeHead(200, { 'Content-Type': 'application/json' });
  rc.res.end(JSON.stringify({ object: 'list', data }));
}
