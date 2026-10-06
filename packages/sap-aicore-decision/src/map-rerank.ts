import {
  DecisionError,
  type DecisionErrorCode,
  type RelevanceScore,
  type Result,
} from '@mcp-abap-adt/llm-agent';

/** HTTP status → DecisionError code (spec §5.3). Same split as typesafe-decision's mapError. */
export function codeForStatus(status: number): DecisionErrorCode {
  if (status === 401 || status === 403) return 'DECISION_AUTH';
  if (status === 429) return 'DECISION_RATE_LIMITED';
  if (status === 400 || status === 404 || status === 422) {
    return 'DECISION_INVALID_REQUEST';
  }
  if (status >= 500) return 'DECISION_UNAVAILABLE';
  return 'DECISION_ERROR';
}

const bad = (message: string): Result<never, DecisionError> => ({
  ok: false,
  error: new DecisionError(`sap-aicore rerank: ${message}`, 'DECISION_ERROR'),
});

/**
 * `{ results: [{ index, relevance_score }] }` → `RelevanceScore[]` (order as
 * returned). Exactly one entry per document, each index once and in range,
 * each score finite. NO [0, 1] check: a relevance score is not a probability
 * (spec §3.9). Anything else is an error — never a zero-filled or dropped score.
 */
export function mapRerankResults(
  body: unknown,
  documents: number,
): Result<RelevanceScore[], DecisionError> {
  const list = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return bad('response has no results array');
  if (list.length !== documents) {
    return bad(`${list.length} results for ${documents} documents`);
  }
  const seen = new Set<number>();
  const out: RelevanceScore[] = [];
  for (const e of list) {
    const index = (e as { index?: unknown } | null)?.index;
    const score = (e as { relevance_score?: unknown } | null)?.relevance_score;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= documents
    ) {
      return bad(`out-of-range index ${String(index)}`);
    }
    if (seen.has(index)) return bad(`index ${index} twice`);
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return bad(`score for index ${index} is not a finite number`);
    }
    seen.add(index);
    out.push({ index, score });
  }
  return { ok: true, value: out };
}
