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

function unit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function sameKeys(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((k) => set.has(k));
}

/** Map and check one answer per requested key; any violation fails the call. */
export function mapAnswers(
  questions: Record<string, DecisionQuestion>,
  raw: Record<string, unknown> | undefined,
): Result<Record<string, DecisionAnswer>, DecisionError> {
  // Built as entries and read as own properties, so a key such as `__proto__`
  // is an answer like any other, never the object's prototype.
  const out: Array<[string, DecisionAnswer]> = [];
  for (const [key, q] of Object.entries(questions)) {
    const a = (raw && Object.hasOwn(raw, key) ? raw[key] : undefined) as
      | Raw
      | undefined;
    if (!a || typeof a !== 'object') return fail(key, 'missing');
    if (a.type !== q.type) {
      return fail(key, `type '${String(a.type)}' does not match '${q.type}'`);
    }
    switch (q.type) {
      case 'noul': {
        if (!unit(a.noul))
          return fail(key, 'probability must be finite in [0, 1]');
        out.push([key, { type: 'noul', probability: a.noul }]);
        break;
      }
      case 'choice': {
        const labels = Object.keys(q.criteria);
        if (typeof a.choice !== 'string' || !labels.includes(a.choice)) {
          return fail(
            key,
            `choice '${String(a.choice)}' is not one of the labels`,
          );
        }
        if (!unit(a.confidence))
          return fail(key, 'confidence must be finite in [0, 1]');
        const probs = (a.probabilities ?? {}) as Raw;
        if (
          typeof probs !== 'object' ||
          !sameKeys(Object.keys(probs), labels)
        ) {
          return fail(key, 'probabilities must cover exactly the labels');
        }
        if (!Object.values(probs).every(unit)) {
          return fail(key, 'every probability must be finite in [0, 1]');
        }
        out.push([
          key,
          {
            type: 'choice',
            choice: a.choice,
            confidence: a.confidence,
            probabilities: { ...(probs as Record<string, number>) },
          },
        ]);
        break;
      }
      case 'score': {
        const top = q.criteria.length - 1;
        if (
          typeof a.score !== 'number' ||
          !Number.isFinite(a.score) ||
          a.score < 0 ||
          a.score > top
        ) {
          return fail(key, `score must be finite in [0, ${top}]`);
        }
        if (!unit(a.confidence))
          return fail(key, 'confidence must be finite in [0, 1]');
        const probs = (a.probabilities ?? {}) as Raw;
        const levels = q.criteria.map((_, i) => String(i));
        if (
          typeof probs !== 'object' ||
          !sameKeys(Object.keys(probs), levels)
        ) {
          return fail(key, `probabilities must cover exactly 0 … ${top}`);
        }
        if (!Object.values(probs).every(unit)) {
          return fail(key, 'every probability must be finite in [0, 1]');
        }
        out.push([
          key,
          {
            type: 'score',
            score: a.score,
            confidence: a.confidence,
            probabilities: numericKeys(probs),
          },
        ]);
        break;
      }
    }
  }
  return { ok: true, value: Object.fromEntries(out) };
}
