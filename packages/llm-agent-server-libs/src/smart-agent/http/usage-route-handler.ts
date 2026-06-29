import type { SessionLifecycle } from '../session-lifecycle/index.js';
import { jsonError } from './response-helpers.js';
import type { RouteContext } from './route-table.js';
import { resolveSessionCookie } from './session-cookie.js';

/**
 * GET /v1/usage — return per-session token-usage summary.
 *
 * Body moved verbatim from `SmartServer._buildRouteTable` (route index 2).
 * `rc.server._lifecycle` (private) is threaded as the `lifecycle` param so the
 * free function compiles without accessing private class fields.
 * The inline cookie block is replaced with `resolveSessionCookie(rc, lifecycle)`.
 */
export async function handleUsageRoute(
  rc: RouteContext,
  lifecycle: SessionLifecycle | undefined,
): Promise<void> {
  if (!lifecycle) {
    rc.res.writeHead(500, { 'Content-Type': 'application/json' });
    rc.res.end(jsonError('Session lifecycle not initialized', 'server_error'));
    return;
  }
  const resolved = resolveSessionCookie(rc, lifecycle);
  const sessionId = resolved.identity.sessionId;
  const graph = await lifecycle.acquire(sessionId);
  try {
    rc.res.writeHead(200, { 'Content-Type': 'application/json' });
    rc.res.end(JSON.stringify(graph.logger.getSummary()));
  } finally {
    lifecycle.release(sessionId, graph);
  }
}
