import {
  type DecisionAnswer,
  DecisionError,
  type DecisionQuestion,
  type Result,
} from '@mcp-abap-adt/llm-agent';

type Raw = Record<string, unknown>;

function fail(key: string, rule: string): Result<never, DecisionError> {
  return {
    ok: false,
    error: new DecisionError(`answer '${key}': ${rule}`, 'DECISION_ERROR'),
  };
}

function numericKeys(obj: Raw): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(obj)) out[Number(k)] = v as number;
  return out;
}

/** Map and check one answer per requested key; any violation fails the call. */
export function mapAnswers(
  questions: Record<string, DecisionQuestion>,
  raw: Record<string, unknown> | undefined,
): Result<Record<string, DecisionAnswer>, DecisionError> {
  const out: Record<string, DecisionAnswer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = raw?.[key] as Raw | undefined;
    if (!a || typeof a !== 'object') return fail(key, 'missing');
    if (a.type !== q.type) {
      return fail(key, `type '${String(a.type)}' does not match '${q.type}'`);
    }
    switch (q.type) {
      case 'noul':
        out[key] = { type: 'noul', probability: a.noul as number };
        break;
      case 'choice':
        out[key] = {
          type: 'choice',
          choice: a.choice as string,
          confidence: a.confidence as number,
          probabilities: { ...(a.probabilities as Record<string, number>) },
        };
        break;
      case 'score':
        out[key] = {
          type: 'score',
          score: a.score as number,
          confidence: a.confidence as number,
          probabilities: numericKeys((a.probabilities ?? {}) as Raw),
        };
        break;
    }
  }
  return { ok: true, value: out };
}
