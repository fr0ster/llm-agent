import type { SessionLifecycle } from '../session-lifecycle/index.js';
import type { RouteContext } from './route-table.js';

/**
 * Resolve session identity from the request cookie and mint+set a Set-Cookie
 * header when a new session id was minted. Extracted verbatim from the 7×
 * repeated inline block in `_buildRouteTable` / `_withSession`. Returns the
 * resolved identity so callers read `resolved.identity.sessionId`.
 */
export function resolveSessionCookie(
  rc: RouteContext,
  lifecycle: SessionLifecycle,
): ReturnType<SessionLifecycle['resolve']> {
  const isHttps =
    (rc.req.socket as { encrypted?: boolean }).encrypted === true ||
    rc.req.headers['x-forwarded-proto'] === 'https';
  const resolved = lifecycle.resolve(rc.req.headers['cookie'], isHttps);
  if (resolved.minted && resolved.setCookie) {
    rc.res.setHeader('Set-Cookie', resolved.setCookie);
  }
  return resolved;
}
