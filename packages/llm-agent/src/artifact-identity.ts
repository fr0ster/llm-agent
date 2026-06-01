/**
 * Identity keys for fetched artefacts (18.1 dedup). The knowledge blackboard's
 * semantic `query()` is lossy top-k on TEXT, so it cannot reliably answer "is
 * THIS exact fetch already done?". An identity key (tool + canonical args) backs
 * an exact-match "already fetched" manifest so planners/executors do not re-fetch
 * the same object (the redundant-read problem in the 2026-06-01 live matrix).
 */

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
 *  fetches with the same (tool, args) share one key → dedup. */
export function artifactIdentityKey(toolName: string, args: unknown): string {
  return `${toolName}:${stableArgsKey(args)}`;
}
