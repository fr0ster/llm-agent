import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../agent.js';
import type { IPipeline, PipelineResult } from '../../interfaces/pipeline.js';
import { makeCapturingTracer, makeDefaultDeps } from '../../testing/index.js';
import type { PipelineContext } from '../context.js';
import { PipelineExecutor } from '../executor.js';
import { pipelineToStream } from '../pipeline-to-stream.js';
import type { IStageHandler } from '../stage-handler.js';

/** A pipeline whose execute resolves with `result`, after yielding `chunks`. */
function fakePipeline(
  result: PipelineResult,
  chunks: Parameters<Parameters<IPipeline['execute']>[3]>[0][] = [],
): IPipeline {
  return {
    initialize: () => {},
    execute: async (_i, _h, _o, yieldChunk) => {
      for (const c of chunks) yieldChunk(c);
      return result;
    },
  } as unknown as IPipeline;
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('N1 — a pipeline error reaches the consumer (spec §10.5.2, D70)', () => {
  it('pipelineToStream yields PipelineResult.error as the last item — today it is dropped', async () => {
    const error = new OrchestratorError(
      'classifier failed',
      'CLASSIFIER_ERROR',
    );
    const out = await collect(
      pipelineToStream(fakePipeline({ timing: [], error }), 'q', [], undefined),
    );
    assert.equal(out.length, 1);
    assert.ok(!out[0].ok && out[0].error.code === 'CLASSIFIER_ERROR');
  });

  it('a handler that yielded its own error is not reported twice', async () => {
    const error = new OrchestratorError('llm down', 'LLM_ERROR');
    const out = await collect(
      pipelineToStream(
        fakePipeline({ timing: [], error }, [{ ok: false, error }]),
        'q',
        [],
        undefined,
      ),
    );
    assert.equal(out.filter((c) => !c.ok).length, 1);
  });

  it('a throwing handler sets ctx.error (PIPELINE_ERROR, naming the stage) — today only a span and a log', async () => {
    const throwing: IStageHandler = {
      execute: async () => {
        throw new Error('boom');
      },
    };
    const ctx = {
      timing: [],
      options: undefined,
    } as unknown as PipelineContext;
    const tracer = makeCapturingTracer();
    const ok = await new PipelineExecutor(
      new Map([['x', throwing]]),
      tracer,
    ).executeStages([{ id: 's1', type: 'x' }], ctx, tracer.startSpan('root'));
    assert.equal(ok, false);
    assert.ok(ctx.error instanceof OrchestratorError);
    assert.equal(ctx.error.code, 'PIPELINE_ERROR');
    assert.match(ctx.error.message, /stage "s1" failed: Error: boom/);
  });

  it('a thrown OrchestratorError keeps its own code', async () => {
    const throwing: IStageHandler = {
      execute: async () => {
        throw new OrchestratorError('down', 'MCP_UNAVAILABLE');
      },
    };
    const ctx = {
      timing: [],
      options: undefined,
    } as unknown as PipelineContext;
    const tracer = makeCapturingTracer();
    await new PipelineExecutor(
      new Map([['x', throwing]]),
      tracer,
    ).executeStages([{ id: 's1', type: 'x' }], ctx, tracer.startSpan('root'));
    assert.equal(ctx.error?.code, 'MCP_UNAVAILABLE');
  });

  it('an unknown stage type is the same error', async () => {
    const ctx = {
      timing: [],
      options: undefined,
    } as unknown as PipelineContext;
    const tracer = makeCapturingTracer();
    await new PipelineExecutor(new Map(), tracer).executeStages(
      [{ id: 's1', type: 'nope' }],
      ctx,
      tracer.startSpan('root'),
    );
    assert.equal(ctx.error?.code, 'PIPELINE_ERROR');
  });

  it('SmartAgent.process() returns the error; the root span is error — today ok: true with empty content', async () => {
    const { deps } = makeDefaultDeps();
    const tracer = makeCapturingTracer();
    const error = new OrchestratorError(
      'classifier failed',
      'CLASSIFIER_ERROR',
    );
    const agent = new SmartAgent(
      { ...deps, tracer, pipeline: fakePipeline({ timing: [], error }) },
      { maxIterations: 5 },
    );
    const r = await agent.process('hello');
    assert.ok(!r.ok && r.error.code === 'CLASSIFIER_ERROR');
    // process() returned on the error chunk, closing streamProcess's generator at that
    // yield: the status must already be set (spec D78).
    const root = tracer.spans.find((s) => s.name === 'smart_agent.process');
    assert.equal(root?.status?.status, 'error');
    assert.match(root?.status?.message ?? '', /CLASSIFIER_ERROR/);
    assert.equal(root?.ended, true, 'ended by finally');
  });

  it('a consumer that stops reading at the error chunk still leaves the root span error and ended (D78)', async () => {
    const { deps } = makeDefaultDeps();
    const tracer = makeCapturingTracer();
    const error = new OrchestratorError('assemble failed', 'PIPELINE_ERROR');
    const agent = new SmartAgent(
      { ...deps, tracer, pipeline: fakePipeline({ timing: [], error }) },
      { maxIterations: 5 },
    );
    const iter = agent.streamProcess('hello')[Symbol.asyncIterator]();
    const first = await iter.next();
    assert.ok(!first.done && !first.value.ok, 'the first chunk is the error');
    // Close early, as `for await … break` and process() do: the generator resumes only
    // into its finally — no code after the yield runs.
    await iter.return?.(undefined);
    const root = tracer.spans.find((s) => s.name === 'smart_agent.process');
    assert.equal(root?.status?.status, 'error');
    assert.equal(root?.ended, true);
  });

  it('pass-through mode: an LLM error chunk leaves the root span error — today ok after the loop', async () => {
    const { deps } = makeDefaultDeps({ llmResponses: [new Error('llm down')] });
    const tracer = makeCapturingTracer();
    const agent = new SmartAgent(
      { ...deps, tracer },
      { maxIterations: 5, mode: 'pass' },
    );
    const r = await agent.process('hello');
    assert.ok(!r.ok, 'the pass-through error reaches the consumer');
    const root = tracer.spans.find((s) => s.name === 'smart_agent.process');
    assert.equal(root?.status?.status, 'error');
    assert.match(root?.status?.message ?? '', /llm down/);
    assert.equal(root?.ended, true);
  });
});
