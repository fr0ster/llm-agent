import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type IDecisionModel,
  type IRequestLogger,
  type LlmCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { wrapDecisionModel } from '../usage-logging-decision-model.js';

function recordingLogger() {
  const calls: LlmCallEntry[] = [];
  const logger = {
    logLlmCall: (e: LlmCallEntry) => calls.push(e),
  } as unknown as IRequestLogger;
  return { calls, logger };
}

const req = { state: 'abcd', questions: { a: { type: 'noul' as const } } };

function model(withUsage: boolean): IDecisionModel {
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

describe('wrapDecisionModel', () => {
  it('logs one decision entry with measured usage', async () => {
    const { calls, logger } = recordingLogger();
    const r = await wrapDecisionModel(model(true)).decide(req, {
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
    await wrapDecisionModel(model(false)).decide(req, {
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
    const r = await wrapDecisionModel(model(true)).decide(req);
    assert.ok(r.ok);
  });

  it('logs nothing on failure', async () => {
    const { calls, logger } = recordingLogger();
    const failing: IDecisionModel = {
      decide: async () => ({ ok: false, error: new DecisionError('x') }),
    };
    await wrapDecisionModel(failing).decide(req, {
      requestLogger: logger,
    } as never);
    assert.equal(calls.length, 0);
  });

  it('is idempotent and keeps the configured model id', () => {
    const once = wrapDecisionModel(model(true));
    assert.equal(wrapDecisionModel(once), once);
    assert.equal(once.model, 'cfg');
  });
});
