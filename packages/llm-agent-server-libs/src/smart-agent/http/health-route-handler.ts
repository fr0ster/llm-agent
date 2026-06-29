import type { RouteContext } from './route-table.js';

/**
 * GET /health | /v1/health — return server + MCP health status.
 *
 * Body moved verbatim from `SmartServer._buildRouteTable` (route index 6).
 * Reads only `rc.healthChecker`, `rc.ready`, and `rc.res` — no private server
 * fields, so no threading is required.
 * MCP-down ⇒ NOT_READY ⇒ 503 (not just LLM-unhealthy), so a load balancer
 * stops routing while MCP is unreachable.
 */
export async function handleHealthRoute(rc: RouteContext): Promise<void> {
  const status = await rc.healthChecker.check();
  const httpCode = status.status === 'unhealthy' || !rc.ready ? 503 : 200;
  rc.res.writeHead(httpCode, { 'Content-Type': 'application/json' });
  rc.res.end(JSON.stringify({ ...status, ready: rc.ready }));
}
