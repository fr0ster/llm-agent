import { createHash } from 'node:crypto';
import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import type { SessionBundle } from './types.js';

// ---------------------------------------------------------------------------
// Run identity
// ---------------------------------------------------------------------------

/** Injectable runId minter (matches the existing id-minter pattern); tests pass a
 *  deterministic counter. Default is time+random based. */
export type RunIdMinter = () => string;

/** Canonical identity fingerprint of a request: a hash of the NORMALIZED text
 *  (trimmed, internal whitespace collapsed). Used only for identity comparison —
 *  the verbatim request is kept separately for the finalizer. */
export function fingerprintRequest(request: string): string {
  const normalized = request.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

// ---------------------------------------------------------------------------
// Terminal store (separate keyed TTL store)
// ---------------------------------------------------------------------------

const TERMINAL_ARTIFACT_TYPE = 'controller-terminal';

export type TerminalOutcome =
  | { kind: 'success'; answer: string }
  | { kind: 'error'; error: string };

interface TerminalEntry {
  runId: string;
  terminalOutcome: TerminalOutcome;
  /** Absolute expiry timestamp (ISO). */
  expiresAt: string;
}

/** Persist a terminal outcome keyed by runId with a TTL. Written into the same
 *  KnowledgeBackend as the bundle but under a distinct artifactType so it
 *  survives the next run's bundle reset (the TTL promise). `nowIso` is passed so
 *  the caller controls time. */
export async function writeTerminal(
  be: KnowledgeBackend,
  sessionId: string,
  runId: string,
  terminalOutcome: TerminalOutcome,
  ttlMs: number,
  nowIso: string,
): Promise<void> {
  const expiresAt = new Date(new Date(nowIso).getTime() + ttlMs).toISOString();
  const entry: TerminalEntry = { runId, terminalOutcome, expiresAt };
  await be.put(sessionId, {
    content: JSON.stringify(entry),
    metadata: {
      traceId: sessionId,
      turnId: sessionId,
      stepperId: 'controller',
      task: 'terminal',
      artifactType: TERMINAL_ARTIFACT_TYPE,
      runId,
      createdAt: nowIso,
    },
  });
}

/** Read the latest non-expired terminal outcome for runId, or undefined. */
export async function readTerminal(
  be: KnowledgeBackend,
  sessionId: string,
  runId: string,
  nowIso: string,
): Promise<TerminalOutcome | undefined> {
  const now = new Date(nowIso).getTime();
  const entries = await be.scan(sessionId);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.metadata.artifactType !== TERMINAL_ARTIFACT_TYPE) continue;
    if (e.metadata.runId !== runId) continue;
    try {
      const parsed = JSON.parse(e.content) as TerminalEntry;
      if (new Date(parsed.expiresAt).getTime() <= now) return undefined;
      return parsed.terminalOutcome;
    } catch {
      // malformed — keep scanning backwards
    }
  }
  return undefined;
}

/** The runIds whose terminal entries are expired as of nowIso (backends without
 *  delete simply ignore stale rows on read). */
export async function gcTerminal(
  be: KnowledgeBackend,
  sessionId: string,
  nowIso: string,
): Promise<string[]> {
  const now = new Date(nowIso).getTime();
  const expired: string[] = [];
  for (const e of await be.scan(sessionId)) {
    if (e.metadata.artifactType !== TERMINAL_ARTIFACT_TYPE) continue;
    try {
      const parsed = JSON.parse(e.content) as TerminalEntry;
      if (new Date(parsed.expiresAt).getTime() <= now) expired.push(parsed.runId);
    } catch {
      // ignore
    }
  }
  return expired;
}

// ---------------------------------------------------------------------------
// Strict request classification
// ---------------------------------------------------------------------------

export type Classification =
  | { kind: 'fresh' }
  | { kind: 'resume' }
  | { kind: 'replay'; runId: string }
  | { kind: 'not-found' };

export interface ClassifyInput {
  bundle: SessionBundle;
  incomingRequest: string;
  /** Explicit idempotency key / runId supplied by the caller (if any). */
  explicitKey?: string;
  /** True when the consumer set the newRun flag for THIS request. */
  newRun?: boolean;
  /** Whether `explicitKey` (or, for fingerprint matches, the current bundle's
   *  runId) has a non-expired terminal-store entry. */
  terminalExists: boolean;
}

/** Strict ordered request classification. First matching branch wins. */
export function classifyRequest(input: ClassifyInput): Classification {
  const { bundle, incomingRequest, explicitKey, newRun, terminalExists } = input;
  // 1. newRun overrides any replay.
  if (newRun) return { kind: 'fresh' };

  // 2. Explicit key → STRICT routing, no fingerprint fallback.
  if (explicitKey) {
    if (terminalExists) return { kind: 'replay', runId: explicitKey };
    const live = bundle.runState === 'active' || bundle.runState === 'suspended';
    if (explicitKey === bundle.runId && live) return { kind: 'resume' };
    return { kind: 'not-found' };
  }

  // 3. No key → fingerprint recovers ONLY an in-flight active run of the same
  //    request; a terminal fingerprint match starts fresh.
  const live = bundle.runState === 'active' || bundle.runState === 'suspended';
  const sameRequest =
    bundle.originalRequest !== undefined &&
    fingerprintRequest(bundle.originalRequest) ===
      fingerprintRequest(incomingRequest);
  if (live && sameRequest) return { kind: 'resume' };
  return { kind: 'fresh' };
}
