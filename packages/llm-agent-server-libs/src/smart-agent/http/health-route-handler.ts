import type { RouteContext } from './route-table.js';

/**
 * GET /health | /v1/health — return server + MCP health status.
 *
 * Body moved verbatim from `SmartServer._buildRouteTable` (route index 6).
 * Reads only `rc.healthChecker`, `rc.ready`, `rc.configNotApplied` and
 * `rc.res` — no private server fields, so no threading is required.
 * 200 only when the server is ready and every configured component works;
 * otherwise 503 (spec §10.5.10, D72).
 */
export async function handleHealthRoute(rc: RouteContext): Promise<void> {
  const status = await rc.healthChecker.check();
  // 200 only when the server is ready and every configured component works (spec §10.5.10, D72, H1): degraded or unhealthy → 503, so a load balancer takes the instance out; the body names what is not working.
  const httpCode = rc.ready && status.status === 'healthy' ? 200 : 503;
  rc.res.writeHead(httpCode, { 'Content-Type': 'application/json' });
  rc.res.end(
    JSON.stringify({
      ...status,
      ready: rc.ready,
      ...(rc.configNotApplied ? { configNotApplied: rc.configNotApplied } : {}),
    }),
  );
}
