import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type IProbabilityDecision,
  type IRelevanceDecision,
  type IRequestLogger,
  type LlmCallEntry,
} from '@mcp-abap-adt/llm-agent';
import {
  ProbabilityReranker,
  RelevanceReranker,
} from '@mcp-abap-adt/llm-agent-reranker';
import {
  wrapProbabilityDecision,
  wrapRelevanceDecision,
} from '../usage-logging-decision-model.js';

function recordingLogger() {
  const calls: LlmCallEntry[] = [];
  const logger = {
    logLlmCall: (e: LlmCallEntry) => calls.push(e),
  } as unknown as IRequestLogger;
  return { calls, logger };
}

const req = { state: 'abcd', questions: { a: { type: 'noul' as const } } };

function model(withUsage: boolean): IProbabilityDecision {
  return {
    model: 'cfg',
    decide: async () => ({
      ok: true,
      value: {
        model: 'jev-1.13.0',
        answers: { a: { type: 'noul', probability: 0.5 } },
        ...(withUsage ? { usage: { inputTokens: 10, outputTokens: 2 } } : {}),
      },
    }),
  };
}

describe('wrapProbabilityDecision', () => {
  it('logs one decision entry with measured usage', async () => {
    const { calls, logger } = recordingLogger();
    const r = await wrapProbabilityDecision(model(true)).decide(req, {
      requestLogger: logger,
      trace: { traceId: 't-1' },
    } as never);
    assert.ok(r.ok);
    assert.equal(calls.length, 1);
    const e = calls[0];
    assert.equal(e.component, 'decision');
    assert.equal(e.model, 'jev-1.13.0');
    assert.equal(e.promptTokens, 10);
    assert.equal(e.completionTokens, 2);
    assert.equal(e.totalTokens, 12);
    assert.equal(e.scope, 'request');
    assert.equal(e.requestId, 't-1');
    assert.equal(e.estimated, undefined);
    assert.ok(e.durationMs >= 0);
  });

  it('estimates when usage is absent', async () => {
    const { calls, logger } = recordingLogger();
    await wrapProbabilityDecision(model(false)).decide(req, {
      requestLogger: logger,
    } as never);
    assert.equal(calls[0].estimated, true);
    assert.equal(calls[0].completionTokens, 0);
    assert.equal(
      calls[0].promptTokens,
      Math.ceil(JSON.stringify(req).length / 4),
    );
  });

  it('is a no-op without a request logger', async () => {
    const r = await wrapProbabilityDecision(model(true)).decide(req);
    assert.ok(r.ok);
  });

  it('logs nothing on failure', async () => {
    const { calls, logger } = recordingLogger();
    const failing: IProbabilityDecision = {
      decide: async () => ({ ok: false, error: new DecisionError('x') }),
    };
    await wrapProbabilityDecision(failing).decide(req, {
      requestLogger: logger,
    } as never);
    assert.equal(calls.length, 0);
  });

  it('is idempotent and keeps the configured model id', () => {
    const once = wrapProbabilityDecision(model(true));
    assert.equal(wrapProbabilityDecision(once), once);
    assert.equal(once.model, 'cfg');
  });
});

describe('wrapRelevanceDecision', () => {
  const relevance = (ok: boolean): IRelevanceDecision => ({
    model: 'cohere-rerank',
    score: async (r) =>
      ok
        ? {
            ok: true,
            value: {
              model: 'cohere-rerank',
              scores: r.passages.map((_, index) => ({ index, score: 0.5 })),
            },
          }
        : {
            ok: false,
            error: new DecisionError('down', 'DECISION_UNAVAILABLE'),
          },
  });
  it('logs a successful call as component decision, estimated tokens without usage', async () => {
    const { calls, logger } = recordingLogger();
    const r = await wrapRelevanceDecision(relevance(true)).score(
      { query: 'q', passages: ['a', 'b'] },
      { requestLogger: logger },
    );
    assert.ok(r.ok);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].component, 'decision');
    assert.equal(calls[0].estimated, true);
  });
  it('a failure is returned and not logged', async () => {
    const { calls, logger } = recordingLogger();
    const r = await wrapRelevanceDecision(relevance(false)).score(
      { query: 'q', passages: ['a'] },
      { requestLogger: logger },
    );
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });
  it('no logger → the inner result, unchanged', async () => {
    const inner = relevance(true);
    const direct = await inner.score({ query: 'q', passages: ['a'] });
    const r = await wrapRelevanceDecision(inner).score({
      query: 'q',
      passages: ['a'],
    });
    assert.deepEqual(r, direct);
  });
  it('idempotent: a wrapped decision is not wrapped again', () => {
    const inner = relevance(true);
    const once = wrapRelevanceDecision(inner);
    assert.notEqual(once, inner);
    assert.equal(wrapRelevanceDecision(once), once);
  });
});

// Spec §17.43 D97: the wrappers keep the provider's cheap check — the server
// always wraps the decision, so a dropped healthCheck would turn every /health
// probe into a model call.
describe('usage-logging wrappers forward healthCheck (D97)', () => {
  it('ProbabilityReranker over a wrapped decision with healthCheck makes no decide call', async () => {
    let decides = 0;
    let checks = 0;
    const d: IProbabilityDecision = {
      decide: async () => {
        decides++;
        return { ok: true, value: { answers: {}, model: 'm' } };
      },
      healthCheck: async () => {
        checks++;
        return { ok: true, value: true };
      },
    };
    const r = await new ProbabilityReranker(
      wrapProbabilityDecision(d),
    ).healthCheck();
    assert.deepEqual(r, { ok: true, value: true });
    assert.equal(checks, 1);
    assert.equal(decides, 0);
  });

  it('RelevanceReranker over a wrapped decision with healthCheck makes no score call', async () => {
    let scores = 0;
    let checks = 0;
    const d: IRelevanceDecision = {
      score: async () => {
        scores++;
        return { ok: true, value: { scores: [], model: 'm' } };
      },
      healthCheck: async () => {
        checks++;
        return { ok: true, value: false };
      },
    };
    const r = await new RelevanceReranker(
      wrapRelevanceDecision(d),
    ).healthCheck();
    assert.deepEqual(r, { ok: true, value: false });
    assert.equal(checks, 1);
    assert.equal(scores, 0);
  });

  it('a wrapped decision without healthCheck has none', () => {
    const p = wrapProbabilityDecision({
      decide: async () => ({ ok: true, value: { answers: {}, model: 'm' } }),
    });
    const s = wrapRelevanceDecision({
      score: async () => ({ ok: true, value: { scores: [], model: 'm' } }),
    });
    assert.equal(p.healthCheck, undefined);
    assert.equal(s.healthCheck, undefined);
  });
});
