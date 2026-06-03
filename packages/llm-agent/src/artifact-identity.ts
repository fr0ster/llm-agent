/**
 * Identity keys for fetched artefacts (18.1 dedup). The knowledge blackboard's
 * semantic `query()` is lossy top-k on TEXT, so it cannot reliably answer "is
 * THIS exact fetch already done?". An identity key (tool + canonical args) backs
 * an exact-match "already fetched" manifest so planners/executors do not re-fetch
 * the same object (the redundant-read problem in the 2026-06-01 live matrix).
 */

import { createHash } from 'node:crypto';

/** Canonical, order-independent serialization of tool arguments so that
 *  `{a:1,b:2}` and `{b:2,a:1}` produce the SAME key. */
export function stableArgsKey(args: unknown): string {
  if (args === null || typeof args !== 'object') return JSON.stringify(args);
  if (Array.isArray(args)) return JSON.stringify(args);
  const obj = args as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

/** Identity of a fetched artefact: the tool name + its canonical args. Two
 *  fetches with the same (tool, args) share one key → dedup.
 *
 *  CASE-NORMALISED (lowercased): models emit the same identifier in varying case
 *  (e.g. an include name `..._F01` vs `..._f01`), which would otherwise produce
 *  distinct keys and defeat dedup/caching. Most fetch args are identifiers where
 *  case is insignificant; lowercasing makes the identity stable. Trade-off
 *  (accepted): two genuinely case-distinct fetches collapse to one — benign for a
 *  dedup heuristic (returns a stored value), and identifiers dominate. */
export function artifactIdentityKey(toolName: string, args: unknown): string {
  return `${toolName}:${stableArgsKey(args)}`.toLowerCase();
}

/** DEEP canonical JSON: recursively sort object keys at every depth; arrays keep
 *  order; case-PRESERVING. Used for external tool-call identity (NOT lowercased). */
export function deepStableArgsKey(args: unknown): string {
  const canon = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canon);
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canon(o[k]);
    return out;
  };
  return JSON.stringify(canon(args));
}

/** First 16 hex chars of sha256. */
export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Deterministic, content-addressed id for a client-provided external tool call
 *  (spec D1). The toolName/args boundary uses a NUL separator (\x00). A space
 *  would let ('a b','c') and ('a','b c') collide. */
const EXT_SEP = '\x00';
export function externalToolCallId(toolName: string, args: unknown): string {
  return `ext:${shortHash(`${toolName}${EXT_SEP}${deepStableArgsKey(args)}`)}`;
}
