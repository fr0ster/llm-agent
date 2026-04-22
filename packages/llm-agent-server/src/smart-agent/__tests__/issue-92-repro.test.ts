/**
 * Reproduction test for issue #92:
 * "LLM never calls GenerateFile tool — writes content directly instead"
 *
 * Root cause hypothesis: non-streaming process() through DefaultPipeline
 * drops external tool_calls.
 *
 * This test covers two scenarios:
 * 1. DefaultPipeline with a single-chunk LLM response (like NonStreamingLlm)
 * 2. DefaultPipeline with realistic multi-delta streaming (like real providers)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmError, LlmStreamChunk, Result } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { makeAssembler, makeClassifier } from '../testing/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXTERNAL_TOOL = {
  name: 'GenerateFile',
  description: 'Generate a file',
  inputSchema: {
    type: 'object' as const,
    properties: {
      fileName: { type: 'string' },
      content: { type: 'string' },
    },
  },
};

const TOOL_ARGS = { fileName: 'test.md', content: '# Hello' };

/** LLM that returns a complete tool call in a single streamChat chunk */
function makeSingleChunkLlm() {
  return {
    model: 'test-single-chunk',
    async chat() {
      return {
        ok: true as const,
        value: {
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'GenerateFile', arguments: TOOL_ARGS },
          ],
          finishReason: 'tool_calls' as const,
        },
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'GenerateFile', arguments: TOOL_ARGS },
          ],
          finishReason: 'tool_calls',
        },
      };
    },
  };
}

/** LLM that streams tool call as multiple deltas (realistic streaming) */
function makeStreamingDeltaLlm() {
  return {
    model: 'test-streaming-delta',
    async chat() {
      return {
        ok: true as const,
        value: {
          content: '',
          toolCalls: [
            { id: 'call_2', name: 'GenerateFile', arguments: TOOL_ARGS },
          ],
          finishReason: 'tool_calls' as const,
        },
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      // Delta 1: id + name + start of arguments
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [
            {
              index: 0,
              id: 'call_2',
              name: 'GenerateFile',
              arguments: '{"fileN',
            },
          ],
        },
      };
      // Delta 2: continuation of arguments (no name, no id)
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [{ index: 0, arguments: 'ame":"test.md","con' }],
        },
      };
      // Delta 3: end of arguments
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [{ index: 0, arguments: 'tent":"# Hello"}' }],
        },
      };
      // Final chunk with finish reason
      yield {
        ok: true,
        value: {
          content: '',
          finishReason: 'tool_calls',
        },
      };
    },
  };
}

function makeAgent(llm: ReturnType<typeof makeSingleChunkLlm>) {
  const pipeline = new DefaultPipeline();
  pipeline.initialize({
    mainLlm: llm,
    mcpClients: [],
    classifier: makeClassifier([{ type: 'action', text: 'generate a file' }]),
    assembler: makeAssembler(),
  });

  return new SmartAgent(
    {
      mainLlm: llm,
      mcpClients: [],
      ragStores: {},
      classifier: makeClassifier([{ type: 'action', text: 'generate a file' }]),
      assembler: makeAssembler(),
      pipeline,
    },
    { maxIterations: 5 },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #92 — DefaultPipeline external tool_calls', () => {
  it('process() returns toolCalls with single-chunk LLM response', async () => {
    const agent = makeAgent(makeSingleChunkLlm());
    const r = await agent.process('Generate a file test.md', {
      externalTools: [EXTERNAL_TOOL],
    });

    assert.ok(
      r.ok,
      `process() should succeed: ${!r.ok ? r.error.message : ''}`,
    );
    assert.equal(
      r.value.stopReason,
      'tool_calls',
      'stopReason should be tool_calls',
    );
    assert.ok(r.value.toolCalls, 'toolCalls should be present');
    assert.equal(r.value.toolCalls?.length, 1);
    assert.equal(r.value.toolCalls?.[0].function.name, 'GenerateFile');
    const args = JSON.parse(r.value.toolCalls?.[0].function.arguments ?? '');
    assert.equal(args.fileName, 'test.md');
  });

  it('process() returns toolCalls with multi-delta streaming LLM', async () => {
    const agent = makeAgent(makeStreamingDeltaLlm());
    const r = await agent.process('Generate a file test.md', {
      externalTools: [EXTERNAL_TOOL],
    });

    assert.ok(
      r.ok,
      `process() should succeed: ${!r.ok ? r.error.message : ''}`,
    );
    assert.equal(
      r.value.stopReason,
      'tool_calls',
      'stopReason should be tool_calls',
    );
    assert.ok(r.value.toolCalls, 'toolCalls should be present');
    assert.equal(r.value.toolCalls?.length, 1);
    assert.equal(r.value.toolCalls?.[0].function.name, 'GenerateFile');
    const args = JSON.parse(r.value.toolCalls?.[0].function.arguments ?? '');
    assert.equal(args.fileName, 'test.md', 'should have complete arguments');
    assert.equal(args.content, '# Hello', 'should have full content argument');
  });

  it('streamProcess() yields external tool deltas with multi-delta streaming', async () => {
    const agent = makeAgent(makeStreamingDeltaLlm());
    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of agent.streamProcess('Generate a file test.md', {
      externalTools: [EXTERNAL_TOOL],
    })) {
      if (chunk.ok) chunks.push(chunk.value);
    }

    const toolChunks = chunks.filter(
      (c) => c.toolCalls && c.toolCalls.length > 0,
    );
    assert.ok(toolChunks.length > 0, 'should have tool call chunks');

    // Collect all arguments from all deltas
    let allArgs = '';
    for (const tc of toolChunks) {
      for (const call of tc.toolCalls ?? []) {
        const delta =
          'arguments' in call
            ? typeof call.arguments === 'string'
              ? call.arguments
              : JSON.stringify(call.arguments)
            : '';
        allArgs += delta;
      }
    }

    // All argument deltas should be forwarded to consumer
    assert.ok(
      allArgs.includes('test.md'),
      `streaming deltas should contain full arguments, got: ${allArgs}`,
    );

    const finishChunk = chunks.find((c) => c.finishReason === 'tool_calls');
    assert.ok(finishChunk, 'should have finishReason: tool_calls');
  });
});
