/** `decision:` — a decision model (numbers, not text). Secrets never here. */
export interface SmartServerDecisionConfig {
  provider: 'typesafe';
  model?: string;
  /** Names the account; the composition root resolves it (default `DECISION`). */
  credentialRef?: string;
  baseUrl?: string;
  /** Per-attempt timeout in ms (positive integer). */
  timeoutMs?: number;
  /** Retries after the first attempt (non-negative integer); `0` disables them. */
  maxRetries?: number;
}

/** One entry of `rag.retrieval` — the retrieval strategy of one store. */
export interface SmartServerRetrievalConfig {
  strategy: 'embedding' | 'rerank' | 'rerank-all';
  /** Required for `rerank` / `rerank-all`; `decision` uses the `decision:` section. */
  reranker?: 'decision' | 'llm';
  /** Key of the llm: map entry; required for reranker: llm. */
  llm?: string;
  question?: 'tool' | 'passage';
  task?: string;
  overfetch?: number;
  maxCandidates?: number;
}

/**
 * The one normalisation of an integer field, shared by the resolver and the
 * validator. `loadYamlConfig` substitutes `${VAR}` as a STRING, so `"5000"` and
 * `"0"` arrive as text and must count as integers; `""` (an unset variable with
 * no fallback) is invalid, never 0.
 */
export function parseIntegerField(
  value: unknown,
): number | 'invalid' | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : 'invalid';
  }
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    return Number(value);
  }
  return 'invalid';
}
