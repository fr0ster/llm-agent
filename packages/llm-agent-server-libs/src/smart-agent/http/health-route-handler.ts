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
  // 503 == NOT READY (can't serve, e.g. MCP down). LLM/RAG/circuit soft
  // signals surface in the body (status: degraded) but do NOT 503 a service
  // that can still serve — a load balancer must not drop a working pod.
  const httpCode = rc.ready ? 200 : 503;
  rc.res.writeHead(httpCode, { 'Content-Type': 'application/json' });
  rc.res.end(JSON.stringify({ ...status, ready: rc.ready }));
}
