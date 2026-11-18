import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
import type { IPipeline } from '../../interfaces/pipeline.js';
import { pipelineToStream } from '../pipeline-to-stream.js';

for (const mode of ['return', 'yield and return', 'throw'] as const) {
  test(`pipeline stream emits a typed ${mode} failure once`, async () => {
    const error = new OrchestratorError(
      'Output truncated',
      'LLM_OUTPUT_TRUNCATED',
    );
    const pipeline: IPipeline = {
      initialize() {},
      async execute(_input, _history, _options, emit) {
        emit({ ok: true, value: { content: 'partial' } });
        if (mode === 'throw') throw error;
        if (mode === 'yield and return') emit({ ok: false, error });
        return { timing: [], error };
      },
    };
    const chunks = [];
    for await (const chunk of pipelineToStream(pipeline, 'Work', [], undefined))
      chunks.push(chunk);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks[0], { ok: true, value: { content: 'partial' } });
    const failure = chunks[1];
    assert.ok(!failure.ok);
    assert.equal(failure.error, error);
  });
}
