/**
 * Session-lifecycle helpers — extracted from smart-server.ts (R3).
 *
 * Free functions and types that compose the SessionGraphFactory + SessionRegistry,
 * seed session knowledge, record start/end, and implement the /v1/sessions
 * extracted handlers. `_withSession` (which touches `SmartServer` instance state)
 * stays in smart-server.ts and calls these helpers via import.
 */

import type {
  IKnowledgeRagHandle,
  ILogger,
  IMcpClient,
  IRag,
  IRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import {
  type SessionAgentParts,
  type SessionGraph,
  SessionGraphFactory,
  SessionRegistry,
  type SmartAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import { resolveSessionIdentity } from '../session-identity-resolver.js';
import type {
  ISessionMetaStore,
  SessionMetaRow,
} from '../session-meta-store.js';

/**
 * Share the parent RAG registry with subagents (per-session worker re-wire).
 * Session/user/global collections written at the top level become visible to
 * workers; the per-call scope filter (`rag-query.ts`) isolates by
 * `ctx.sessionId` / `ctx.options.userId`. A worker's own declared store is
 * registered INTO this same registry under its namespace. When the parent
 * registry is undefined (no top-level registry yet — e.g. unit test seam),
 * return undefined so the builder allocates its own SimpleRagRegistry.
 */
export function resolveSubAgentRagRegistry(input: {
  parentRagRegistry: IRagRegistry | undefined;
}): IRagRegistry | undefined {
  return input.parentRagRegistry;
}

/**
 * Options for `buildSessionLifecycle`. Composes the SessionGraphFactory + the
 * SessionRegistry; exposes a thin facade so `_handle` stays unit-testable.
 */
export interface SessionLifecycleOptions {
  idleTtlMs: number;
  maxSessions: number;
  cookieName: string;
  mcpClients: IMcpClient[];
  toolsRag: IRag | undefined;
  ragRegistry: IRagRegistry;
  buildAgent: (parts: SessionAgentParts) => Promise<SmartAgent | undefined>;
  /** Optional logger forwarded to SessionGraphFactory for cleanup-failure surfacing. */
  logger?: ILogger;
  /**
   * Optional per-session teardown hook run during `SessionGraph.dispose()`.
   * The host wires this to invoke the pipeline plugin's
   * `IPipelineInstance.close()` captured by `buildPipelineInstance`.
   */
  onDispose?: (sessionId: string) => Promise<void>;
}

/**
 * Composes the cookie identity resolver + SessionGraphFactory + SessionRegistry
 * into one lifecycle object the server's `_handle` consumes. The default MCP
 * factory returns the shared GLOBAL clients by reference (one upstream
 * connection); a creds-aware build swaps it out (out of scope here).
 */
export function buildSessionLifecycle(opts: SessionLifecycleOptions): {
  resolve: (
    cookieHeader: string | undefined,
    isHttps: boolean,
  ) => ReturnType<typeof resolveSessionIdentity>;
  acquire: (
    sessionId: string,
  ) => Promise<
    ReturnType<SessionRegistry['acquire']> extends Promise<infer G> ? G : never
  >;
  release: (sessionId: string, graph?: SessionGraph) => void;
  evictIdle: () => Promise<void>;
  disposeAll: () => Promise<void>;
  invalidateAll: () => Promise<void>;
  registry: SessionRegistry;
} {
  const factory = new SessionGraphFactory({
    mcpClientFactory: (_identity) => opts.mcpClients,
    toolsRag: opts.toolsRag,
    ragRegistry: opts.ragRegistry,
    buildAgent: opts.buildAgent,
    logger: opts.logger,
    onDispose: opts.onDispose,
  });
  const registry = new SessionRegistry({
    idleTtlMs: opts.idleTtlMs,
    maxSessions: opts.maxSessions,
    factory,
  });
  return {
    resolve: (cookieHeader, isHttps) =>
      resolveSessionIdentity({
        cookieHeader,
        cookieName: opts.cookieName,
        maxAgeSeconds: Math.max(1, Math.floor(opts.idleTtlMs / 1000)),
        isHttps,
      }),
    acquire: (sessionId) => registry.acquire(sessionId),
    release: (sessionId, graph) => registry.release(sessionId, graph),
    evictIdle: () => registry.evictIdle(),
    disposeAll: () => registry.disposeAll(),
    invalidateAll: () => registry.invalidateAll(),
    registry,
  };
}

export type SessionLifecycle = ReturnType<typeof buildSessionLifecycle>;

// ---------------------------------------------------------------------------
// /v1/sessions extracted handlers (testable without a live HTTP server)
// ---------------------------------------------------------------------------

/** Response shape for GET /v1/sessions */
export interface SessionListBody {
  sessions: SessionMetaRow[];
}

/** Response shape for POST /v1/sessions/:id/resume */
export interface SessionResumeBody {
  ok: boolean;
  session?: SessionMetaRow;
  error?: string;
}

/**
 * Seed session-scope guidance entries into a BRAND-NEW session's knowledge-RAG
 * (deployment-supplied tool-usage guidance the planner/executor read in "Known
 * facts"). Idempotent: rehydrates via init() and writes ONLY when the session is
 * empty (`fingerprint() === 'n=0'`), so resumes never duplicate. Entries are
 * config DATA — the runtime stays MCP-agnostic (no tool knowledge in agent code).
 */
export async function seedSessionKnowledge(
  kr: IKnowledgeRagHandle & {
    init?(): Promise<void>;
    fingerprint?(): string;
  },
  seeds: ReadonlyArray<{ content: string; artifactType: string }>,
  nowIso: string,
): Promise<void> {
  if (seeds.length === 0) return;
  await kr.init?.();
  if (kr.fingerprint?.() !== 'n=0') return; // not a brand-new session → skip
  for (const s of seeds) {
    await kr.write({
      content: s.content,
      metadata: {
        traceId: 'seed',
        turnId: 'seed',
        stepperId: 'seed',
        task: 'session-seed',
        artifactType: s.artifactType,
        createdAt: nowIso,
      },
    });
  }
}

/**
 * Record that a request for `sessionId` STARTED — create the meta row on first
 * sight, else touch it and mark in-progress. Called from the live request path
 * (`_withSession`) so GET /v1/sessions, resume and delete actually see sessions
 * produced by normal chat/stream traffic (review Finding 3). `userIdentity` is
 * the sessionId itself in the default no-auth build — matching how the
 * /v1/sessions endpoints resolve identity (`resolved.identity.sessionId`).
 */
export async function recordSessionStart(
  store: ISessionMetaStore,
  sessionId: string,
  nowIso: string,
): Promise<void> {
  const existing = await store.get(sessionId);
  if (!existing) {
    await store.create({
      sessionId,
      userIdentity: sessionId,
      createdAt: nowIso,
      lastUsedAt: nowIso,
      status: 'in-progress',
    });
    return;
  }
  await store.touch(sessionId, nowIso);
  await store.setStatus(sessionId, 'in-progress');
}

/**
 * Record that a request for `sessionId` FINISHED — touch + mark idle (so it can
 * be resumed). No-op if the row was deleted mid-flight.
 */
export async function recordSessionEnd(
  store: ISessionMetaStore,
  sessionId: string,
  nowIso: string,
): Promise<void> {
  const existing = await store.get(sessionId);
  if (!existing) return;
  await store.touch(sessionId, nowIso);
  await store.setStatus(sessionId, 'idle');
}

/**
 * List all sessions for a given user identity.
 * Extracted for unit-testability (mirrors the /v1/usage handler pattern).
 */
export async function handleListSessions(
  store: ISessionMetaStore,
  identity: string,
): Promise<SessionListBody> {
  const sessions = await store.listForUser(identity);
  return { sessions };
}

/**
 * Resume (claim) a session by ID for a user identity.
 * Sets the session status to 'idle' so it can be re-entered.
 */
export async function handleResumeSession(
  store: ISessionMetaStore,
  identity: string,
  id: string,
): Promise<SessionResumeBody> {
  const row = await store.get(id);
  if (!row || row.userIdentity !== identity) {
    return { ok: false, error: 'session not found' };
  }
  await store.setStatus(id, 'idle');
  const updated = await store.get(id);
  return { ok: true, session: updated };
}

/**
 * Delete a session by ID for a user identity, and evict its RAG state.
 */
export async function handleDeleteSession(
  store: ISessionMetaStore,
  identity: string,
  id: string,
  evictFn: (sessionId: string) => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
  const row = await store.get(id);
  if (!row || row.userIdentity !== identity) {
    return { ok: false, error: 'session not found' };
  }
  await store.delete(id);
  await evictFn(id);
  return { ok: true };
}
