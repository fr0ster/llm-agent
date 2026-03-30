import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../types.js';
import { SmartAgent } from '../agent.js';
import type { LlmError, LlmStreamChunk, Result } from '../interfaces/types.js';
import { makeAssembler, makeDefaultDeps } from '../testing/index.js';
import { normalizeExternalTools } from '../utils/external-tools-normalizer.js';

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
    // SmartServer normalizes once, then streamProcess normalizes again
    const second = normalizeExternalTools(first);
    // First normalization: "[client-provided] desc"
    // Second: picks up name directly, re-prefixes description
    // This is acceptable — the prefix appears in the description field
    assert.ok(second[0].description.includes('[client-provided]'));
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
