import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError, OrchestratorError } from '@mcp-abap-adt/llm-agent';
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

test('pipeline stream uses the existing wrapper for a thrown MCP tool error', async () => {
  const error = new McpError('Tool failed', 'MCP_ERROR');
  const pipeline: IPipeline = {
    initialize() {},
    async execute() {
      throw error;
    },
  };
  const chunks = [];
  for await (const chunk of pipelineToStream(pipeline, 'Work', [], undefined))
    chunks.push(chunk);
  assert.equal(chunks.length, 1);
  const [chunk] = chunks;
  assert.ok(chunk && !chunk.ok);
  assert.equal(chunk.error.code, 'PIPELINE_ERROR');
  assert.equal(chunk.error.message, String(error));
});
