import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LlmError,
  LlmStreamChunk,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { normalizeExternalTools } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { makeAssembler, makeDefaultDeps } from '../testing/index.js';

// ---------------------------------------------------------------------------
// [client-provided] prefix on external tool descriptions
// ---------------------------------------------------------------------------

describe('External tools — [client-provided] description prefix', () => {
  it('prefixes description in direct format', () => {
    const tools = normalizeExternalTools([
      {
        name: 'write_file',
        description: 'Write a file to disk',
        inputSchema: { type: 'object' },
      },
    ]);
    assert.equal(tools.length, 1);
    assert.equal(
      tools[0].description,
      '[client-provided] Write a file to disk',
    );
  });

  it('prefixes description in OpenAI function format', () => {
    const tools = normalizeExternalTools([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object' },
        },
      },
    ]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].description, '[client-provided] Read a file');
  });

  it('prefixes even when description is empty', () => {
    const tools = normalizeExternalTools([
      { name: 'ping', inputSchema: { type: 'object' } },
    ]);
    assert.equal(tools.length, 1);
    assert.ok(tools[0].description.startsWith('[client-provided]'));
  });

  it('does not double-prefix on re-normalization', () => {
    const first = normalizeExternalTools([
      { name: 'tool', description: 'desc', inputSchema: { type: 'object' } },
    ]);
    assert.equal(first[0].description, '[client-provided] desc');
    // SmartServer normalizes once, then streamProcess normalizes again
    const second = normalizeExternalTools(first);
    assert.equal(second.length, 1);
    assert.equal(
      second[0].description,
      '[client-provided] desc',
      'second normalization must not add another prefix',
    );
  });

  it('preserves all fields on re-normalization', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } } };
    const first = normalizeExternalTools([
      {
        name: 'GenerateFile',
        description: 'Generate a file',
        inputSchema: schema,
      },
    ]);
    const second = normalizeExternalTools(first);
    assert.equal(second[0].name, 'GenerateFile');
    assert.equal(second[0].description, '[client-provided] Generate a file');
    assert.deepEqual(second[0].inputSchema, schema);
  });

  it('re-normalization of OpenAI function format is idempotent', () => {
    const first = normalizeExternalTools([
      {
        type: 'function',
        function: {
          name: 'RunQuery',
          description: 'Execute a query',
          parameters: { type: 'object' },
        },
      },
    ]);
    const second = normalizeExternalTools(first);
    const third = normalizeExternalTools(second);
    assert.equal(first[0].description, '[client-provided] Execute a query');
    assert.equal(second[0].description, first[0].description);
    assert.equal(third[0].description, first[0].description);
  });

  it('still normalizes tools without [client-provided] prefix', () => {
    const tools = normalizeExternalTools([
      {
        name: 'fresh_tool',
        description: 'Brand new',
        inputSchema: { type: 'object' },
      },
    ]);
    assert.equal(tools[0].description, '[client-provided] Brand new');
  });
});

// ---------------------------------------------------------------------------
// System prompt injection for tool priority
// ---------------------------------------------------------------------------

describe('External tools — system prompt priority instruction', () => {
  it('injects priority instruction into system message when external tools present', async () => {
    let capturedMessages: Message[] = [];

    const streamLlm = {
      async chat() {
        return {
          ok: true as const,
          value: { content: 'ok', finishReason: 'stop' as const },
        };
      },
      async *streamChat(
        msgs: Message[],
      ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        capturedMessages = msgs;
        yield {
          ok: true,
          value: { content: 'ok', finishReason: 'stop' },
        };
      },
      async healthCheck() {
        return { ok: true as const, value: true };
      },
    };

    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'unused' }],
      assembler: makeAssembler([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'test' },
      ]),
    });
    deps.mainLlm = streamLlm;
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    await agent.process('test', {
      externalTools: [
        {
          name: 'ext_tool',
          description: 'External tool',
          inputSchema: { type: 'object' },
        },
      ],
      sessionId: 'test-priority',
    });

    const sys = capturedMessages.find((m) => m.role === 'system');
    assert.ok(sys, 'system message should exist');
    assert.ok(
      sys.content?.includes('Always prefer internal tools'),
      'should contain priority instruction',
    );
    assert.ok(
      sys.content?.includes('[client-provided]'),
      'should mention client-provided marker',
    );
  });

  it('does not inject priority instruction when no external tools', async () => {
    let capturedMessages: Message[] = [];

    const streamLlm = {
      async chat() {
        return {
          ok: true as const,
          value: { content: 'ok', finishReason: 'stop' as const },
        };
      },
      async *streamChat(
        msgs: Message[],
      ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        capturedMessages = msgs;
        yield {
          ok: true,
          value: { content: 'ok', finishReason: 'stop' },
        };
      },
      async healthCheck() {
        return { ok: true as const, value: true };
      },
    };

    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'unused' }],
      assembler: makeAssembler([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'test' },
      ]),
    });
    deps.mainLlm = streamLlm;
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    await agent.process('test', { sessionId: 'test-no-ext' });

    const sys = capturedMessages.find((m) => m.role === 'system');
    assert.ok(sys, 'system message should exist');
    assert.ok(
      !sys.content?.includes('Always prefer internal tools'),
      'should NOT contain priority instruction without external tools',
    );
  });
});
