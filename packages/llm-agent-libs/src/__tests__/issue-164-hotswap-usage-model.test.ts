/**
 * Reproduction / regression test for issue #164:
 * "usage.models keyed by the INITIAL model after a hot-swap".
 *
 * Scenario: getSmartAgent(requestedModel) hot-swaps the main LLM via
 * agent.reconfigure({ mainLlm }). The per-chunk SSE `model` and the
 * "Model hot-swapped" log reflect the new model, BUT the aggregated
 * `usage.models` (RequestSummary.byModel) was still keyed by the INITIAL
 * model name. Consumer UIs read usage.models to show "which model handled
 * this turn" and therefore showed the stale name.
 *
 * This drives a real SmartAgent through its DefaultPipeline (the path that
 * emits usage.models from the tool-loop handler via
 * ctx.requestLogger.logLlmCall({ model: ctx.mainLlm.model })) and reads
 * SessionRequestLogger.getSummary(traceId).byModel — exercising the full
 * reconfigure -> log -> aggregate chain.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmError, LlmStreamChunk, Result } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { makeAssembler, makeClassifier } from '../testing/index.js';

/** A clean-answer stub LLM with a stable `.model` and reported usage. */
function makeAnswerLlm(model: string) {
  return {
    model,
    async chat() {
      return {
        ok: true as const,
        value: {
          content: 'done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      yield {
        ok: true,
        value: {
          content: 'done',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      };
    },
  };
}

function makeAgent(llm: ReturnType<typeof makeAnswerLlm>) {
  const requestLogger = new SessionRequestLogger();
  const pipeline = new DefaultPipeline();
  pipeline.initialize({
    mainLlm: llm,
    mcpClients: [],
    classifier: makeClassifier([{ type: 'action', text: 'do the thing' }]),
    assembler: makeAssembler(),
    requestLogger,
  });

  const agent = new SmartAgent(
    {
      mainLlm: llm,
      mcpClients: [],
      ragStores: {},
      classifier: makeClassifier([{ type: 'action', text: 'do the thing' }]),
      assembler: makeAssembler(),
      pipeline,
      requestLogger,
    },
    { maxIterations: 5 },
  );

  return { agent, requestLogger };
}

describe('Issue #164 — usage.models follows the hot-swapped model', () => {
  it('byModel is keyed by the live model before AND after reconfigure', async () => {
    const { agent, requestLogger } = makeAgent(makeAnswerLlm('model-A'));

    // ---- Request 1: model-A ----
    const trace1 = { traceId: 'trace-1' };
    const r1 = await agent.process('first request', { trace: trace1 });
    assert.ok(
      r1.ok,
      `request 1 should succeed: ${!r1.ok ? r1.error.message : ''}`,
    );

    const summary1 = requestLogger.getSummary(trace1.traceId);
    assert.ok(
      summary1.byModel['model-A'],
      `byModel should be keyed by model-A, got: ${JSON.stringify(Object.keys(summary1.byModel))}`,
    );
    assert.ok(
      !summary1.byModel['model-B'],
      'model-B must not appear before swap',
    );

    // ---- Hot-swap to model-B ----
    agent.reconfigure({ mainLlm: makeAnswerLlm('model-B') });

    // ---- Request 2: model-B ----
    const trace2 = { traceId: 'trace-2' };
    const r2 = await agent.process('second request', { trace: trace2 });
    assert.ok(
      r2.ok,
      `request 2 should succeed: ${!r2.ok ? r2.error.message : ''}`,
    );

    const summary2 = requestLogger.getSummary(trace2.traceId);
    // THE BUG (#164): this was keyed by 'model-A' (the initial model) even
    // though the live LLM is now 'model-B'.
    assert.ok(
      summary2.byModel['model-B'],
      `after hot-swap, byModel must be keyed by model-B, got: ${JSON.stringify(Object.keys(summary2.byModel))}`,
    );
    assert.ok(
      !summary2.byModel['model-A'],
      `after hot-swap, model-A must NOT appear (stale-model regression), got: ${JSON.stringify(Object.keys(summary2.byModel))}`,
    );
  });
});
