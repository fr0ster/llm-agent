import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import {
  handleDeleteSession,
  handleListSessions,
  handleResumeSession,
  type SessionLifecycle,
} from '../session-lifecycle/index.js';
import type { ISessionMetaStore } from '../session-meta-store.js';
import { jsonError } from './response-helpers.js';
import type { RouteContext } from './route-table.js';
import { resolveSessionCookie } from './session-cookie.js';

export async function handleSessionsList(
  rc: RouteContext,
  lifecycle: SessionLifecycle | undefined,
  metaStore: ISessionMetaStore,
): Promise<void> {
  if (!lifecycle) {
    rc.res.writeHead(500, { 'Content-Type': 'application/json' });
    rc.res.end(jsonError('Session lifecycle not initialized', 'server_error'));
    return;
  }
  const resolved = resolveSessionCookie(rc, lifecycle);
  const identity = resolved.identity.sessionId;
  const body = await handleListSessions(metaStore, identity);
  rc.res.writeHead(200, { 'Content-Type': 'application/json' });
  rc.res.end(JSON.stringify(body));
}

export async function handleSessionResume(
  rc: RouteContext,
  lifecycle: SessionLifecycle | undefined,
  metaStore: ISessionMetaStore,
): Promise<void> {
  const resumeMatch = rc.urlPath.match(/^\/v1\/sessions\/([^/]+)\/resume$/);
  if (!resumeMatch) return;
  const sessionId = resumeMatch[1];
  if (!lifecycle) {
    rc.res.writeHead(500, { 'Content-Type': 'application/json' });
    rc.res.end(jsonError('Session lifecycle not initialized', 'server_error'));
    return;
  }
  const resolved = resolveSessionCookie(rc, lifecycle);
  const identity = resolved.identity.sessionId;
  const body = await handleResumeSession(metaStore, identity, sessionId);
  const status = body.ok ? 200 : 404;
  rc.res.writeHead(status, { 'Content-Type': 'application/json' });
  rc.res.end(JSON.stringify(body));
}

export async function handleSessionDelete(
  rc: RouteContext,
  lifecycle: SessionLifecycle | undefined,
  metaStore: ISessionMetaStore,
  knowledgeBackend: KnowledgeBackend | undefined,
): Promise<void> {
  const deleteMatch = rc.urlPath.match(/^\/v1\/sessions\/([^/]+)$/);
  if (!deleteMatch) return;
  const sessionId = deleteMatch[1];
  if (!lifecycle) {
    rc.res.writeHead(500, { 'Content-Type': 'application/json' });
    rc.res.end(jsonError('Session lifecycle not initialized', 'server_error'));
    return;
  }
  const resolved = resolveSessionCookie(rc, lifecycle);
  const identity = resolved.identity.sessionId;
  const evictFn = async (sid: string) => {
    await lifecycle.registry.evictOne(sid);
    await knowledgeBackend?.deleteSession(sid);
  };
  const body = await handleDeleteSession(
    metaStore,
    identity,
    sessionId,
    evictFn,
  );
  const status = body.ok ? 200 : 404;
  rc.res.writeHead(status, { 'Content-Type': 'application/json' });
  rc.res.end(JSON.stringify(body));
}
